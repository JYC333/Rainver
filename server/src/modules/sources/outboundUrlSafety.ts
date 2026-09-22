import {
  createOutboundGuard,
  guardedFetch,
  OutboundAddressRefusedError,
  OutboundGuardError,
  undiciPinnedFetch,
  type GuardedRequest,
  type GuardedResponse,
  type OutboundGuard,
} from "@rainver/outbound-guard";
import { HttpError } from "../routeUtils/common.js";

/**
 * The control plane's side of the one outbound boundary.
 *
 * The address policy, redirect rules, byte ceiling and pinned undici transport
 * live in `@rainver/outbound-guard`, shared with the host daemon. This adapter
 * translates guard failures into the gateway's own error type.
 */
export { isBlockedAddress } from "@rainver/outbound-guard";
export type { GuardedResponse, OutboundGuard } from "@rainver/outbound-guard";

/** This instance's boundary. One instance: it holds no per-request state. */
export const outboundGuard: OutboundGuard = createOutboundGuard();

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
    return await guardedFetch(request, { guard, fetch: undiciPinnedFetch });
  } catch (error) {
    if (error instanceof OutboundAddressRefusedError) throw new OutboundRefusedError(error.message);
    if (error instanceof OutboundGuardError) throw new HttpError(error.status, error.message);
    throw error;
  }
}
