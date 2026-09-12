import { readBodyUpTo } from "./body.js";
import { OutboundGuardError } from "./errors.js";
import { parseOutboundHttpUrl, type OutboundGuard, type PinnedAddress } from "./guard.js";

/**
 * How long a whole fetch — name resolution, every redirect hop, and the body —
 * may take when the caller names no budget of its own.
 *
 * Sized against what this is allowed to download rather than against a page
 * load: a Source's ceiling is 5 MiB by default, and two minutes for that is
 * ~43 KB/s, below any link a scan would otherwise succeed on. The paths that
 * take the default — a connection scan, and the manual-URL / arXiv extract that
 * may pull a whole PDF — had no ceiling at all before, so this bounds them
 * rather than tightening them. Backfill passes its own, smaller budget.
 */
export const DEFAULT_OUTBOUND_DEADLINE_MS = 120_000;
export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Request headers that are credentials whatever a caller calls them. They are
 * dropped on a cross-origin hop even when they arrive in `headers`, so a caller
 * that puts a bearer in the wrong field still does not hand it to a redirect
 * target.
 */
const ALWAYS_CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

export interface PinnedFetchInit {
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  redirect: "manual";
}

/**
 * Performs one hop, connecting only to `pinned`.
 *
 * Supplied by the consumer because pinning is an HTTP-client concern: the
 * control plane builds a dispatcher from `pinnedAddressLookup`. The guard owns
 * *what* may be reached; this owns *how* the socket is opened.
 */
export type PinnedFetch = (
  url: string,
  init: PinnedFetchInit,
  pinned: readonly PinnedAddress[],
) => Promise<Response>;

export interface GuardedRequest {
  url: string;
  method?: string;
  /** Sent on every hop, including after a redirect to another origin. */
  headers?: Record<string, string>;
  /**
   * Dropped the moment the chain leaves the first origin: an API key, a
   * bearer, a cookie. Separate from `headers` so a credential cannot leak by a
   * caller forgetting to name it in a list.
   */
  credentialHeaders?: Record<string, string>;
  /** Hard ceiling on the body read; the remainder is cancelled. */
  maxDownloadBytes: number;
  /** Whole-chain budget, name resolution included. */
  deadlineMs?: number;
  signal?: AbortSignal;
  maxRedirects?: number;
}

export interface GuardedResponse {
  /** The URL the body came from, after every redirect. */
  url: string;
  status: number;
  ok: boolean;
  headers: Headers;
  /** Never longer than `maxDownloadBytes`. Empty for 304 and for any non-OK status. */
  bytes: Uint8Array;
  /** The body was longer than `maxDownloadBytes`, or the upstream declared that it was. */
  truncated: boolean;
}

/**
 * Header names are folded to lower case so one spelling of a credential cannot
 * survive a strip that matched another. Two spellings of the same header
 * therefore collapse to the last one rather than combining into a list; no
 * caller sends a header twice, and reliable stripping is worth more than
 * multi-value support this has no use for.
 */
function lowerCaseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
}

/**
 * Fetches a URL through the guard: every hop's address is checked and then
 * connected to, credentials stop at the first origin, and the body is capped.
 */
export async function guardedFetch(
  request: GuardedRequest,
  deps: { guard: OutboundGuard; fetch: PinnedFetch },
): Promise<GuardedResponse> {
  const start = parseOutboundHttpUrl(request.url);
  const safeHeaders = lowerCaseHeaders(request.headers);
  const credentialHeaders = lowerCaseHeaders(request.credentialHeaders);
  const carriesCredentials = Object.keys(credentialHeaders).length > 0
    || Object.keys(safeHeaders).some((name) => ALWAYS_CREDENTIAL_HEADERS.has(name));
  const maxRedirects = request.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const deadline = AbortSignal.timeout(request.deadlineMs ?? DEFAULT_OUTBOUND_DEADLINE_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;

  let current = start;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const sameOrigin = current.origin === start.origin;
    if (carriesCredentials && !sameOrigin && start.protocol === "https:" && current.protocol === "http:") {
      // The path and query of a credentialed request are as sensitive as the
      // credential; handing them to cleartext because an upstream asked is the
      // downgrade, whether or not the credential itself still travels.
      throw new OutboundGuardError(502, "Outbound URL redirected from https to http");
    }
    const headers = sameOrigin
      ? { ...safeHeaders, ...credentialHeaders }
      : Object.fromEntries(Object.entries(safeHeaders).filter(([name]) => !ALWAYS_CREDENTIAL_HEADERS.has(name)));

    const pinned = await deps.guard.pin(current, signal);
    const response = await deps.fetch(
      current.toString(),
      { method: request.method ?? "GET", headers, signal, redirect: "manual" },
      pinned,
    );

    // 304 sits inside the redirect range but is an answer, not a hop: a
    // conditional request that is told "unchanged" has arrived.
    if (response.status === 304 || response.status < 300 || response.status >= 400) {
      return await readGuardedBody(current.toString(), response, request.maxDownloadBytes);
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      return { url: current.toString(), status: response.status, ok: false, headers: response.headers, bytes: new Uint8Array(0), truncated: false };
    }
    current = parseOutboundHttpUrl(new URL(location, current).toString());
  }
  throw new OutboundGuardError(502, "Outbound URL redirected too many times");
}

async function readGuardedBody(url: string, response: Response, maxDownloadBytes: number): Promise<GuardedResponse> {
  // A body nobody is going to read is still a transfer this process pays for,
  // and an upstream that answers an error with megabytes of HTML is ordinary.
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { url, status: response.status, ok: false, headers: response.headers, bytes: new Uint8Array(0), truncated: false };
  }
  const { bytes, truncated } = await readBodyUpTo(response, maxDownloadBytes);
  return { url, status: response.status, ok: true, headers: response.headers, bytes, truncated };
}
