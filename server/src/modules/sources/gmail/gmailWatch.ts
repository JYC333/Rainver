/**
 * `users.watch` — the one Gmail POST of background sync. It asks Gmail to
 * publish this mailbox's changes to the configured Pub/Sub topic (which must
 * live in the same Google Cloud project as the Gmail OAuth client; Gmail
 * refuses another project's topic). Calling it again renews the same watch.
 *
 * Sent through the outbound guard like the OAuth POSTs: HTTPS, exactly the
 * fixed watch URL, `maxRedirects: 0` with a fixed JSON body, 64 KiB response
 * cap, 15 s deadline. That deadline is this module's own signal, so when it
 * ends the outcome is `timeout` (sent or not), never `uncertain` / `not_sent`.
 * The bearer is resolved per hop after pinning
 * (`headersForHop`), and `admit` (the sync's authority + lease recheck and the
 * durable quota) runs in `beforeSend` as the last await before dispatch. An
 * `admit` refusal is rethrown unchanged — never reported as `not_sent` — so a
 * caller cannot mistake lost authority for a watch outcome.
 * Rainver never calls `users.stop`: a watch of a disconnected mailbox simply
 * expires within seven days, and its pushes find no active monitor.
 */
import { fetchGuarded, outboundGuard, type OutboundGuard } from "../outboundUrlSafety.js";
import { GMAIL_SYNC_LIMITS, GMAIL_WATCH_URL, isHistoryId } from "./gmailSyncContract.js";

let guardOverride: OutboundGuard | null = null;
let deadlineOverride: number | null = null;
/** Tests inject a DNS-stubbed guard (and optionally a shorter per-send deadline); the transport stays the production one. */
export function __setGmailWatchGuardForTests(guard: OutboundGuard | null, options: { deadlineMs?: number | null } = {}): void {
  guardOverride = guard;
  deadlineOverride = options.deadlineMs ?? null;
}

export type GmailWatchOutcome =
  | { kind: "ok"; expiresAt: string; historyId: string }
  | { kind: "refused"; status: number }
  /** Google's `Retry-After` (raw header, if any) on a 429/5xx: the caller turns it into its retry time. */
  | { kind: "unavailable"; status: number; retryAfter: string | null }
  | { kind: "not_sent" }
  /** The request's own 15 s deadline ended (before or after dispatch). */
  | { kind: "timeout" }
  | { kind: "uncertain" };

export async function startGmailWatch(input: {
  topicName: string;
  bearer: () => Promise<string>;
  admit: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<GmailWatchOutcome> {
  let sent = false;
  let admitError: { error: unknown } | null = null;
  const deadlineMs = deadlineOverride ?? GMAIL_SYNC_LIMITS.perSendDeadlineMs;
  const deadline = AbortSignal.timeout(deadlineMs);
  try {
    const response = await fetchGuarded({
      url: GMAIL_WATCH_URL,
      method: "POST",
      requireHttps: true,
      maxRedirects: 0,
      maxDownloadBytes: 64 * 1024,
      deadlineMs,
      headers: { "content-type": "application/json", accept: "application/json" },
      // All mailbox changes (no label filter): the sync filters what is new mail.
      body: JSON.stringify({ topicName: input.topicName }),
      headersForHop: async (hop) => {
        if (hop.toString() !== GMAIL_WATCH_URL) throw new Error("gmail_watch_url_refused");
        return { credentialHeaders: { authorization: `Bearer ${await input.bearer()}` } };
      },
      beforeSend: async (hop) => {
        if (hop.toString() !== GMAIL_WATCH_URL) throw new Error("gmail_watch_url_refused");
        try { await input.admit(); } catch (error) { admitError = { error }; throw error; }
        sent = true;
      },
      signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
    }, guardOverride ?? outboundGuard);
    if (response.status === 429 || response.status >= 500) return { kind: "unavailable", status: response.status, retryAfter: response.headers.get("retry-after") };
    if (!response.ok) return response.status >= 300 && response.status < 400 ? { kind: "uncertain" } : { kind: "refused", status: response.status };
    const body = JSON.parse(new TextDecoder().decode(response.bytes)) as { historyId?: unknown; expiration?: unknown };
    const expiration = typeof body.expiration === "string" && /^[0-9]{1,16}$/.test(body.expiration) ? Number(body.expiration) : NaN;
    if (!isHistoryId(body.historyId) || !Number.isFinite(expiration)) return { kind: "uncertain" };
    return { kind: "ok", historyId: body.historyId, expiresAt: new Date(expiration).toISOString() };
  } catch {
    // Assigned inside the guard's callback, which control-flow narrowing cannot see.
    const refused = admitError as { error: unknown } | null;
    if (refused) throw refused.error;
    if (deadline.aborted) return { kind: "timeout" };
    return sent ? { kind: "uncertain" } : { kind: "not_sent" };
  }
}
