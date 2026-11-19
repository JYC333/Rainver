/**
 * The Gmail requests of one digest read call (ADR 0033 phase B), on the owner
 * read's sequence (`gmailMailReads.ts`): admission transaction → Sources
 * broker outside every transaction (account/owner quota, token refresh,
 * authority + the caller's consent/delivery recheck before every send, no
 * redirects, 2 MiB / 15 s per response) → in-memory normalization.
 *
 * Allowlist (`assertGmailDigestReadUrl`), nothing else:
 * - daily: `messages.list` with exactly `maxResults` (≤ 10), `labelIds=INBOX`,
 *   `q=after:<epoch> before:<epoch>` (server-built from the frozen window, no
 *   person's words) and optionally `pageToken`;
 * - every kind: `messages.get format=full` of a listed or frozen id.
 * Drafts, chats, spam and trash are dropped even when listed. Rule digests
 * page through their frozen ids by offset; no list request is sent for them.
 */
import { GMAIL_DIGEST_LIMITS, type GmailAgentMessage, type GmailDigestKind } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import type { Pool } from "../../../db/pool.js";
import type { SourceRequestGrant, SourceRequestRoute } from "../sourceRequestBroker.js";
import { admit, pageTransport, record } from "./gmailMailReads.js";
import { GmailReadError, type GmailReadSnapshot } from "./gmailReadAuthority.js";
import { gmailPageScope } from "./gmailReadDeadline.js";
import { GMAIL_AGENT_EXCLUDED_LABELS } from "./gmailAgentReadContract.js";
import { createGmailSendBudget, GMAIL_API_ORIGIN, GMAIL_READ_LIMITS, GmailContractError, gmailMessageFullUrl } from "./gmailReadContract.js";
import { gmailId, headerValue, internalDateIso, normalizeMessageBody, type GmailApiMessage } from "./gmailMessageText.js";

const MESSAGES = "/gmail/v1/users/me/messages";
const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const RULE_TOKEN = /^r([1-9][0-9]{0,3})$/;

export function gmailDigestListUrl(input: { start: Date; end: Date; pageToken: string | null }): string {
  const url = new URL(`${GMAIL_API_ORIGIN}${MESSAGES}`);
  url.searchParams.set("maxResults", String(GMAIL_DIGEST_LIMITS.messagesPerCall));
  url.searchParams.set("labelIds", "INBOX");
  url.searchParams.set("q", `after:${Math.max(0, Math.floor(input.start.getTime() / 1000) - 1)} before:${Math.ceil(input.end.getTime() / 1000)}`);
  if (input.pageToken !== null) url.searchParams.set("pageToken", input.pageToken);
  assertGmailDigestReadUrl(url.toString());
  return url.toString();
}

export function assertGmailDigestReadUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new GmailContractError("gmail_url_refused"); }
  if (url.origin !== GMAIL_API_ORIGIN || url.username || url.password || url.hash || url.port) throw new GmailContractError("gmail_url_refused");
  const p = url.searchParams;
  const keys = [...p.keys()];
  if (url.pathname === MESSAGES) {
    const ok = keys.every((key) => ["maxResults", "labelIds", "q", "pageToken"].includes(key))
      && ["maxResults", "labelIds", "q", "pageToken"].every((key) => p.getAll(key).length <= 1)
      && p.get("maxResults") === String(GMAIL_DIGEST_LIMITS.messagesPerCall) && p.get("labelIds") === "INBOX"
      && /^after:[0-9]{1,12} before:[0-9]{1,12}$/.test(p.get("q") ?? "")
      && (!p.has("pageToken") || PAGE_TOKEN.test(p.get("pageToken")!));
    if (!ok) throw new GmailContractError("gmail_url_refused");
    return url;
  }
  if (/^\/gmail\/v1\/users\/me\/messages\/[0-9a-f]{1,64}$/.test(url.pathname) && keys.length === 1 && p.getAll("format").length === 1 && p.get("format") === "full") return url;
  throw new GmailContractError("gmail_url_refused");
}

function routes(credentialHeaders: () => Promise<Record<string, string>>): SourceRequestRoute[] {
  return [{ origin: GMAIL_API_ORIGIN, path_prefix: MESSAGES, methods: ["GET"], query_keys: ["maxResults", "labelIds", "q", "pageToken", "format"], credentialHeaders }];
}

function gmailDigestSourceRequestPolicy(input: { credentialHeaders: () => Promise<Record<string, string>>; budget: ReturnType<typeof createGmailSendBudget> }):
  Pick<SourceRequestGrant, "routes" | "maxRedirects" | "assertHopUrl" | "beforePhysicalSend" | "maxBytes" | "deadlineMs"> {
  return {
    routes: routes(input.credentialHeaders),
    maxRedirects: 0,
    assertHopUrl: (url) => { assertGmailDigestReadUrl(url.toString()); },
    beforePhysicalSend: (url) => input.budget.consume(url),
    maxBytes: GMAIL_READ_LIMITS.responseBytes,
    deadlineMs: GMAIL_READ_LIMITS.perSendDeadlineMs,
  };
}

export interface GmailDigestReadRequest {
  spaceId: string; ownerUserId: string; connectionId: string; kind: GmailDigestKind;
  window: { start: Date; end: Date };
  /** Rule digests: the frozen matched ids of this delivery. */
  ids: readonly string[] | null;
  pageToken: string | null;
  signal: AbortSignal;
  authorizeSend: (signal: AbortSignal) => Promise<void>;
}

export interface GmailDigestReadResult {
  snapshot: GmailReadSnapshot;
  items: GmailAgentMessage[];
  nextPageToken: string | null;
  truncated: boolean;
}

/** Reads one page of a digest's frozen window or ids. A malformed page token is a fixed refusal before any send. */
export async function readGmailDigestPage(config: ServerConfig, pool: Pool, input: GmailDigestReadRequest): Promise<GmailDigestReadResult> {
  if (!config.gmailOAuth) throw new GmailReadError(503, "gmail_not_configured");
  let offset = 0;
  if (input.kind === "rule") {
    if (input.pageToken !== null) {
      const match = RULE_TOKEN.exec(input.pageToken);
      if (!match) throw new GmailReadError(422, "gmail_cursor_invalid");
      offset = Number(match[1]);
    }
  } else if (input.pageToken !== null && !PAGE_TOKEN.test(input.pageToken)) throw new GmailReadError(422, "gmail_cursor_invalid");
  const scope = gmailPageScope(config, pool, input.signal);
  const snapshot = await admit(scope, { spaceId: input.spaceId, ownerUserId: input.ownerUserId, projectId: null, connectionId: input.connectionId, agentRead: true }, async () => {});
  const transport = pageTransport(config, scope, snapshot, {
    scopeId: `gmail-digest-read:${snapshot.connectionId}`,
    policy: gmailDigestSourceRequestPolicy,
    budget: createGmailSendBudget(1 + GMAIL_DIGEST_LIMITS.messagesPerCall),
    authorizeSend: input.authorizeSend,
  });
  let ids: string[];
  let nextPageToken: string | null = null;
  if (input.kind === "daily") {
    const list = await transport.get(gmailDigestListUrl({ start: input.window.start, end: input.window.end, pageToken: input.pageToken }));
    if (list.kind !== "ok") throw new GmailReadError(502, "gmail_upstream_error");
    const body = record(list.json);
    if (!list.json || typeof list.json !== "object" || Array.isArray(list.json)) throw new GmailReadError(502, "gmail_upstream_error");
    const entries = body.messages === undefined ? [] : body.messages;
    if (!Array.isArray(entries) || entries.length > GMAIL_DIGEST_LIMITS.messagesPerCall) throw new GmailReadError(502, "gmail_upstream_error");
    ids = [...new Set(entries.map((entry) => {
      const id = gmailId(record(entry).id);
      if (!id) throw new GmailReadError(502, "gmail_upstream_error");
      return id;
    }))];
    if (body.nextPageToken !== undefined) {
      if (typeof body.nextPageToken !== "string" || !PAGE_TOKEN.test(body.nextPageToken) || body.nextPageToken === input.pageToken) {
        throw new GmailReadError(502, "gmail_upstream_error");
      }
      nextPageToken = body.nextPageToken;
    }
  } else {
    const frozen = input.ids ?? [];
    ids = frozen.slice(offset, offset + GMAIL_DIGEST_LIMITS.messagesPerCall);
    nextPageToken = offset + ids.length < frozen.length ? `r${offset + ids.length}` : null;
  }
  const items: GmailAgentMessage[] = [];
  const startMs = input.window.start.getTime(), endMs = input.window.end.getTime();
  for (const id of ids) {
    if (!transport.roomForAnotherSend()) throw new GmailReadError(502, "gmail_upstream_error");
    const got = await transport.get(gmailMessageFullUrl(id));
    if (got.kind !== "ok") throw new GmailReadError(502, "gmail_upstream_error");
    const full = record(got.json) as GmailApiMessage;
    const labels = Array.isArray(full.labelIds) ? full.labelIds.filter((l): l is string => typeof l === "string") : [];
    const at = internalDateIso(full.internalDate);
    if (gmailId(full.id) !== id || !at || !Array.isArray(full.labelIds)) throw new GmailReadError(502, "gmail_upstream_error");
    if (labels.some((label) => GMAIL_AGENT_EXCLUDED_LABELS.has(label))) continue;
    // Gmail's after:/before: are second-granular: a daily window keeps exactly its own mail.
    if (input.kind === "daily" && (!labels.includes("INBOX") || Date.parse(at) < startMs || Date.parse(at) >= endMs)) continue;
    const headers = full.payload?.headers;
    items.push({
      id, internal_date: at,
      subject: headerValue(headers, "Subject"), from: headerValue(headers, "From"), to: headerValue(headers, "To"),
      cc: headerValue(headers, "Cc"), date_header: headerValue(headers, "Date"),
      ...normalizeMessageBody(full.payload, GMAIL_DIGEST_LIMITS.textBytesPerMessage),
    });
  }
  return { snapshot, items, nextPageToken, truncated: items.some((item) => item.text_truncated) };
}
