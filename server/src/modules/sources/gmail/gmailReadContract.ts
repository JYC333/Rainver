/**
 * Gmail read-only — fixed Google endpoints, exact read-URL allowlist and
 * granted-scope policy (`.agent/modules/sources.md`, "Personal Gmail connections").
 *
 * Pure rules only: no network, credentials, DB or OAuth flow. Consumers must
 * build every Gmail URL with these builders and create the broker from
 * `gmailSourceRequestPolicy`. The
 * broker's route prefixes alone are not narrow enough (`/messages` also matches
 * `/messages/{id}/attachments/{id}`), so the policy refuses redirects and
 * applies `assertGmailReadUrl` to every hop, and its send budget is debited per
 * physical send rather than per broker call.
 */
import type { SourceRequestGrant, SourceRequestRoute } from "../sourceRequestBroker.js";

export const GMAIL_API_ORIGIN = "https://gmail.googleapis.com" as const;
const USER = "/gmail/v1/users/me";
export const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth" as const;
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token" as const;

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly" as const;
/** `openid` yields the stable Google subject used for same-account reconnect checks. */
export const GMAIL_REQUESTED_SCOPES = ["openid", GMAIL_READONLY_SCOPE] as const;
/** Identity-only scopes Google may report alongside; they grant no mailbox authority. */
const IDENTITY_ONLY_SCOPES = new Set([
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

export const GMAIL_READ_LIMITS = Object.freeze({
  messagesPerPage: 20,
  /** Each physical Gmail response; the broker refuses larger bodies. */
  responseBytes: 2 * 1024 * 1024,
  /** Raw bytes fetched for one search or reading page, all sends together. */
  pageRawBytes: 8 * 1024 * 1024,
  normalizedTextBytesPerMessage: 256 * 1024,
  normalizedPageBytes: 1024 * 1024,
  perSendDeadlineMs: 15_000,
  /** One whole page — routing, admission, every send, token refresh, quota, release — not 21 × 15 s. */
  pageDeadlineMs: 60_000,
  /** 1 thread-metadata + 20 message sends. */
  sendsPerPage: 21,
});

export class GmailContractError extends Error {
  constructor(readonly code: "gmail_url_refused" | "gmail_id_invalid" | "gmail_query_invalid" | "gmail_send_budget_exhausted") {
    super(code);
    this.name = "GmailContractError";
  }
}

// Gmail thread/message ids are lowercase hex; anything else is refused rather than encoded.
const GMAIL_ID = /^[0-9a-f]{1,64}$/;
const METADATA_HEADERS = ["Subject", "From", "To", "Date"] as const;

function gmailId(value: string): string {
  if (!GMAIL_ID.test(value)) throw new GmailContractError("gmail_id_invalid");
  return value;
}

export function gmailProfileUrl(): string {
  return `${GMAIL_API_ORIGIN}${USER}/profile`;
}

/** Headers and message ids only; Gmail returns the whole thread, never a page of it. */
export function gmailThreadMetadataUrl(threadId: string): string {
  const url = new URL(`${GMAIL_API_ORIGIN}${USER}/threads/${gmailId(threadId)}`);
  url.searchParams.set("format", "metadata");
  for (const header of METADATA_HEADERS) url.searchParams.append("metadataHeaders", header);
  return url.toString();
}

export function gmailMessageFullUrl(messageId: string): string {
  const url = new URL(`${GMAIL_API_ORIGIN}${USER}/messages/${gmailId(messageId)}`);
  url.searchParams.set("format", "full");
  return url.toString();
}

type ReadShape = { path: RegExp; query: (params: URLSearchParams) => boolean };
const only = (params: URLSearchParams, keys: readonly string[]) => [...params.keys()].every((key) => keys.includes(key));
const single = (params: URLSearchParams, key: string) => params.getAll(key).length === 1;
/** Exactly the four headers, each once: a missing header would let Gmail return every header. */
const sameHeaderSet = (headers: string[]) => headers.length === METADATA_HEADERS.length
  && new Set(headers).size === headers.length
  && headers.every((h) => (METADATA_HEADERS as readonly string[]).includes(h));
const READ_SHAPES: readonly ReadShape[] = [
  { path: /^\/gmail\/v1\/users\/me\/profile$/, query: (p) => [...p.keys()].length === 0 },
  {
    path: /^\/gmail\/v1\/users\/me\/threads\/[0-9a-f]{1,64}$/,
    query: (p) => only(p, ["format", "metadataHeaders"]) && single(p, "format") && p.get("format") === "metadata"
      && sameHeaderSet(p.getAll("metadataHeaders")),
  },
  {
    path: /^\/gmail\/v1\/users\/me\/messages\/[0-9a-f]{1,64}$/,
    query: (p) => only(p, ["format"]) && single(p, "format") && p.get("format") === "full",
  },
];

/**
 * The only Gmail requests an owner read may send: profile, thread metadata and
 * one full message (thread search was retired with Gmail V2). Send, drafts,
 * modify, trash, labels, history, settings, watch, attachments, raw format and
 * other mailboxes are refused. Background sync has its own, separate
 * allowlist (`gmailSyncContract.ts`).
 */
export function assertGmailReadUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new GmailContractError("gmail_url_refused"); }
  if (url.origin !== GMAIL_API_ORIGIN || url.username || url.password || url.hash || url.port) {
    throw new GmailContractError("gmail_url_refused");
  }
  const shape = READ_SHAPES.find((candidate) => candidate.path.test(url.pathname));
  if (!shape || !shape.query(url.searchParams)) throw new GmailContractError("gmail_url_refused");
  return url;
}

/**
 * Broker routes for a Gmail grant. Credential headers are resolved per hop by
 * the server-owned callback; the routes are GET only, so no mailbox mutation
 * method is representable. Prefix routes are never used without the exact
 * per-hop rule in `gmailSourceRequestPolicy`.
 */
export function gmailSourceRequestRoutes(credentialHeaders: () => Promise<Record<string, string>>): SourceRequestRoute[] {
  return [
    { origin: GMAIL_API_ORIGIN, path_prefix: `${USER}/profile`, methods: ["GET"], query_keys: [], credentialHeaders },
    { origin: GMAIL_API_ORIGIN, path_prefix: `${USER}/threads`, methods: ["GET"], query_keys: ["format", "metadataHeaders"], credentialHeaders },
    { origin: GMAIL_API_ORIGIN, path_prefix: `${USER}/messages`, methods: ["GET"], query_keys: ["format"], credentialHeaders },
  ];
}

/** Physical-send budget for one search or reading page; debited by the broker before every send, redirects included. */
export interface GmailSendBudget { readonly remaining: number; consume(url: URL): void }
export function createGmailSendBudget(limit: number = GMAIL_READ_LIMITS.sendsPerPage): GmailSendBudget {
  let remaining = limit;
  return {
    get remaining() { return remaining; },
    consume() {
      if (remaining < 1) throw new GmailContractError("gmail_send_budget_exhausted");
      remaining -= 1;
    },
  };
}

/**
 * The transport half of a Gmail broker grant: no redirects (Gmail read APIs do
 * not redirect, and a hop would otherwise get a credential on a prefix match),
 * the exact allowlist on every hop before credentials resolve, the per-page send
 * budget per physical send, and the per-response size and deadline. Phase 2
 * supplies scopeId, quota (see `gmailQuota.ts`) and `authorize`.
 */
export function gmailSourceRequestPolicy(input: {
  credentialHeaders: () => Promise<Record<string, string>>;
  budget: GmailSendBudget;
}): Pick<SourceRequestGrant, "routes" | "maxRedirects" | "assertHopUrl" | "beforePhysicalSend" | "maxBytes" | "deadlineMs"> {
  return {
    routes: gmailSourceRequestRoutes(input.credentialHeaders),
    maxRedirects: 0,
    assertHopUrl: (url) => { assertGmailReadUrl(url.toString()); },
    beforePhysicalSend: (url) => input.budget.consume(url),
    maxBytes: GMAIL_READ_LIMITS.responseBytes,
    deadlineMs: GMAIL_READ_LIMITS.perSendDeadlineMs,
  };
}

export type GmailScopeDecision =
  | { ok: true; scopes: string[] }
  | { ok: false; code: "gmail_scope_missing" | "gmail_scope_excess"; scopes: string[] };

/**
 * Accept a token only when it carries gmail.readonly and nothing beyond
 * identity-only scopes. Any other scope (gmail.modify/send/compose/insert/
 * labels/settings, mail.google.com, metadata, or a non-Gmail API) refuses it:
 * the caller must not store the token (it is discarded, never revoked automatically).
 */
export function evaluateGrantedGmailScopes(scope: string | null | undefined): GmailScopeDecision {
  const scopes = [...new Set((scope ?? "").split(/\s+/).filter(Boolean))].sort();
  if (scopes.some((value) => value !== GMAIL_READONLY_SCOPE && !IDENTITY_ONLY_SCOPES.has(value))) {
    return { ok: false, code: "gmail_scope_excess", scopes };
  }
  if (!scopes.includes(GMAIL_READONLY_SCOPE)) return { ok: false, code: "gmail_scope_missing", scopes };
  return { ok: true, scopes };
}
