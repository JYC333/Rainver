import { Agent } from "undici";
import {
  createOutboundGuard,
  guardedFetch,
  OutboundAddressRefusedError,
  OutboundGuardError,
  pinnedAddressLookup,
  type GuardedRequest,
  type GuardedResponse,
  type OutboundGuard,
  type PinnedFetch,
} from "@rainver/outbound-guard";
import { HttpError } from "../routeUtils/common.js";

/**
 * The control plane's side of the one outbound boundary.
 *
 * The block list, the redirect rules and the byte ceiling live in
 * `@rainver/outbound-guard`, shared with the host daemon's egress proxy. What
 * this file adds is the two things only a server needs: an HTTP client that
 * connects to the address the guard checked, and the translation of a refusal
 * into the gateway's own error type.
 */
export { isBlockedAddress } from "@rainver/outbound-guard";
export type { GuardedResponse, OutboundGuard } from "@rainver/outbound-guard";

/** This instance's boundary. One instance: it holds no per-request state. */
export const outboundGuard: OutboundGuard = createOutboundGuard();

/**
 * Performs one hop against the addresses the guard pinned.
 *
 * `globalThis.fetch` reads `dispatcher` from its init, so pinning needs no
 * second HTTP client — and a test that replaces `globalThis.fetch` still
 * intercepts this.
 *
 * `pipelining: 0` is doing two jobs and both are load-bearing. It stops a
 * connection kept alive for one pinned address from being handed to the next
 * request for the same name, whose pin may legitimately differ. And because
 * this dispatcher is per request and nothing closes it — the response body is
 * read after this returns — it is also what releases the socket: with
 * keep-alive left on, twenty sequential fetches leave twenty sockets open for
 * the Agent's idle timeout. Do not remove it as tidying.
 */
const pinnedFetch: PinnedFetch = (url, init, pinned) => {
  const request: RequestInit & { dispatcher?: unknown } = {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    redirect: init.redirect,
    dispatcher: new Agent({ connect: { lookup: pinnedAddressLookup(pinned) }, pipelining: 0 }),
  };
  return globalThis.fetch(url, request);
};

/**
 * Fetches a user-influenced URL through the boundary.
 *
 * Every server outbound call that takes a URL from a Source, a Recipe, a
 * handler or a redirect goes through here. Provider API calls do not: ADR-level
 * decision D2 keeps `base_url` free to name a private address, because a local
 * Ollama is a real deployment.
 */
/**
 * The boundary refused the address, rather than the URL being malformed.
 *
 * Carried as its own class so a scan can decide whether retrying is sensible
 * without reading the message — which is deliberately the same whether the name
 * resolved into this instance's network or resolved nowhere at all.
 */
export class OutboundRefusedError extends HttpError {
  constructor(message: string) {
    super(422, message);
    this.name = "OutboundRefusedError";
  }
}

export async function fetchGuarded(
  request: GuardedRequest,
  guard: OutboundGuard = outboundGuard,
): Promise<GuardedResponse> {
  try {
    return await guardedFetch(request, { guard, fetch: pinnedFetch });
  } catch (error) {
    if (error instanceof OutboundAddressRefusedError) throw new OutboundRefusedError(error.message);
    if (error instanceof OutboundGuardError) throw new HttpError(error.status, error.message);
    throw error;
  }
}
