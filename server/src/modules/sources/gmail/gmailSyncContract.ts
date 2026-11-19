/**
 * Gmail V2 background sync — fixed Google endpoints and the exact per-hop URL
 * allowlist for mailbox sync, kept apart from the owner-read allowlist in
 * `gmailReadContract.ts` (which stays unchanged). Pure rules only.
 *
 * The sync may send only:
 *   GET  /users/me/profile                                   (baseline / recovery position)
 *   GET  /users/me/history?startHistoryId&historyTypes=messageAdded&maxResults=100[&pageToken]
 *   GET  /users/me/messages?q=after:<epoch>&maxResults=40[&pageToken]   (bounded cursor recovery)
 *   GET  /users/me/messages/{id}?format=metadata&metadataHeaders=Subject|From|To  (headers only)
 *   POST /users/me/watch                                     (fixed body; `gmailWatch.ts`)
 * Never a message body (`format=full|raw`), an attachment, a label/settings
 * write or another mailbox. `gmail.readonly` covers all of them.
 */
import type { SourceRequestGrant, SourceRequestRoute } from "../sourceRequestBroker.js";
import { GMAIL_API_ORIGIN, GmailContractError, gmailProfileUrl } from "./gmailReadContract.js";

const USER = "/gmail/v1/users/me";
export const GMAIL_WATCH_URL = `${GMAIL_API_ORIGIN}${USER}/watch` as const;

export const GMAIL_SYNC_LIMITS = Object.freeze({
  historyPageSize: 100,
  historyPagesPerSync: 5,
  /** One recovery page, sized to the per-sync message bound; a further page is reported as partial. */
  recoveryPageSize: 40,
  /** A cursor gap older than this is not scanned; the remainder is reported as partial. */
  recoveryMaxDays: 7,
  /** Header-only message reads per sync; the rest waits for the next sync (cursor not advanced past it). */
  messagesPerSync: 40,
  /** Physical sends per sync: profile + history/recovery pages + message metadata. */
  sendsPerSync: 50,
  responseBytes: 1024 * 1024,
  perSendDeadlineMs: 15_000,
  /** A crashed sync's lease expires after this; a live one finishes well inside it (one page deadline). */
  leaseMs: 180_000,
  /** Without a current watch (push not configured or unhealthy). */
  pollIntervalMs: 15 * 60_000,
  /** With a current watch: the scheduled check is only the catch-up for lost or late pushes. */
  pushedPollIntervalMs: 6 * 60 * 60_000,
  /** `users.watch` lasts 7 days; renew once it has less than this left. */
  watchRenewBeforeMs: 24 * 60 * 60_000,
  matchRetentionDays: 30,
});

/** Gmail labels whose messages are never "new mail" for a monitor. */
export const GMAIL_NON_INBOUND_LABELS: ReadonlySet<string> = new Set(["DRAFT", "SENT", "SPAM", "TRASH", "CHAT"]);

const HISTORY_ID = /^[0-9]{1,20}$/;
const GMAIL_ID = /^[0-9a-f]{1,64}$/;
const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;
const AFTER_QUERY = /^after:[0-9]{1,12}$/;
const SYNC_HEADERS = ["Subject", "From", "To"] as const;

export function gmailHistoryUrl(input: { startHistoryId: string; pageToken?: string | null }): string {
  if (!HISTORY_ID.test(input.startHistoryId)) throw new GmailContractError("gmail_id_invalid");
  const url = new URL(`${GMAIL_API_ORIGIN}${USER}/history`);
  url.searchParams.set("startHistoryId", input.startHistoryId);
  url.searchParams.set("historyTypes", "messageAdded");
  url.searchParams.set("maxResults", String(GMAIL_SYNC_LIMITS.historyPageSize));
  if (input.pageToken != null) {
    if (!PAGE_TOKEN.test(input.pageToken)) throw new GmailContractError("gmail_query_invalid");
    url.searchParams.set("pageToken", input.pageToken);
  }
  return url.toString();
}

/** Recovery listing: only `after:<epoch seconds>`, never a person's query text. */
export function gmailRecoveryListUrl(input: { afterEpochSeconds: number; pageToken?: string | null }): string {
  const after = Math.floor(input.afterEpochSeconds);
  if (!Number.isSafeInteger(after) || after < 0) throw new GmailContractError("gmail_query_invalid");
  const url = new URL(`${GMAIL_API_ORIGIN}${USER}/messages`);
  url.searchParams.set("q", `after:${after}`);
  url.searchParams.set("maxResults", String(GMAIL_SYNC_LIMITS.recoveryPageSize));
  if (input.pageToken != null) {
    if (!PAGE_TOKEN.test(input.pageToken)) throw new GmailContractError("gmail_query_invalid");
    url.searchParams.set("pageToken", input.pageToken);
  }
  return url.toString();
}

/** Labels, internal date and three headers; no body part is returned for `format=metadata`. */
export function gmailMessageMetadataUrl(messageId: string): string {
  if (!GMAIL_ID.test(messageId)) throw new GmailContractError("gmail_id_invalid");
  const url = new URL(`${GMAIL_API_ORIGIN}${USER}/messages/${messageId}`);
  url.searchParams.set("format", "metadata");
  for (const header of SYNC_HEADERS) url.searchParams.append("metadataHeaders", header);
  return url.toString();
}

export { gmailProfileUrl };

type Shape = { path: RegExp; query: (p: URLSearchParams) => boolean };
const only = (p: URLSearchParams, keys: readonly string[]) => [...p.keys()].every((key) => keys.includes(key));
const single = (p: URLSearchParams, key: string) => p.getAll(key).length === 1;
const optionalToken = (p: URLSearchParams) => p.getAll("pageToken").length <= 1 && (!p.has("pageToken") || PAGE_TOKEN.test(p.get("pageToken")!));
const SHAPES: readonly Shape[] = [
  { path: /^\/gmail\/v1\/users\/me\/profile$/, query: (p) => [...p.keys()].length === 0 },
  {
    path: /^\/gmail\/v1\/users\/me\/history$/,
    query: (p) => only(p, ["startHistoryId", "historyTypes", "maxResults", "pageToken"])
      && single(p, "startHistoryId") && HISTORY_ID.test(p.get("startHistoryId")!)
      && single(p, "historyTypes") && p.get("historyTypes") === "messageAdded"
      && single(p, "maxResults") && p.get("maxResults") === String(GMAIL_SYNC_LIMITS.historyPageSize) && optionalToken(p),
  },
  {
    path: /^\/gmail\/v1\/users\/me\/messages$/,
    query: (p) => only(p, ["q", "maxResults", "pageToken"]) && single(p, "q") && AFTER_QUERY.test(p.get("q")!)
      && single(p, "maxResults") && p.get("maxResults") === String(GMAIL_SYNC_LIMITS.recoveryPageSize) && optionalToken(p),
  },
  {
    path: /^\/gmail\/v1\/users\/me\/messages\/[0-9a-f]{1,64}$/,
    query: (p) => {
      const headers = p.getAll("metadataHeaders");
      return only(p, ["format", "metadataHeaders"]) && single(p, "format") && p.get("format") === "metadata"
        && headers.length === SYNC_HEADERS.length && new Set(headers).size === headers.length
        && headers.every((h) => (SYNC_HEADERS as readonly string[]).includes(h));
    },
  },
];

/** The only GETs a background sync may send; everything else (bodies, attachments, writes) is refused. */
export function assertGmailSyncUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new GmailContractError("gmail_url_refused"); }
  if (url.origin !== GMAIL_API_ORIGIN || url.username || url.password || url.hash || url.port) throw new GmailContractError("gmail_url_refused");
  const shape = SHAPES.find((candidate) => candidate.path.test(url.pathname));
  if (!shape || !shape.query(url.searchParams)) throw new GmailContractError("gmail_url_refused");
  return url;
}

function syncRoutes(credentialHeaders: () => Promise<Record<string, string>>): SourceRequestRoute[] {
  return [
    { origin: GMAIL_API_ORIGIN, path_prefix: `${USER}/profile`, methods: ["GET"], query_keys: [], credentialHeaders },
    { origin: GMAIL_API_ORIGIN, path_prefix: `${USER}/history`, methods: ["GET"], query_keys: ["startHistoryId", "historyTypes", "maxResults", "pageToken"], credentialHeaders },
    { origin: GMAIL_API_ORIGIN, path_prefix: `${USER}/messages`, methods: ["GET"], query_keys: ["q", "maxResults", "pageToken", "format", "metadataHeaders"], credentialHeaders },
  ];
}

/** Physical-send budget for one sync, debited per send by the broker. */
export function createGmailSyncBudget(limit: number = GMAIL_SYNC_LIMITS.sendsPerSync): { readonly remaining: number; consume(): void } {
  let remaining = limit;
  return {
    get remaining() { return remaining; },
    consume() {
      if (remaining < 1) throw new GmailContractError("gmail_send_budget_exhausted");
      remaining -= 1;
    },
  };
}

/** Same transport discipline as the read policy: no redirects, the exact allowlist per hop, per-send budget. */
export function gmailSyncRequestPolicy(input: {
  credentialHeaders: () => Promise<Record<string, string>>;
  budget: { consume(): void };
}): Pick<SourceRequestGrant, "routes" | "maxRedirects" | "assertHopUrl" | "beforePhysicalSend" | "maxBytes" | "deadlineMs"> {
  return {
    routes: syncRoutes(input.credentialHeaders),
    maxRedirects: 0,
    assertHopUrl: (url) => { assertGmailSyncUrl(url.toString()); },
    beforePhysicalSend: () => input.budget.consume(),
    maxBytes: GMAIL_SYNC_LIMITS.responseBytes,
    deadlineMs: GMAIL_SYNC_LIMITS.perSendDeadlineMs,
  };
}

/** Numeric compare of Gmail history ids (uint64 decimal strings). */
export function historyIdGreater(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}
export function isHistoryId(value: unknown): value is string {
  return typeof value === "string" && HISTORY_ID.test(value);
}
