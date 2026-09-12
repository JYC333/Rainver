/**
 * A refusal from the outbound boundary, with the HTTP status the caller should
 * answer with. The package stays free of any framework's error type; the one
 * consumer that answers HTTP requests maps this at its edge.
 */
export class OutboundGuardError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "OutboundGuardError";
  }
}

/**
 * The one answer for "this URL may not be fetched", whether the host resolved
 * to a blocked address, resolved to nothing, or could not be resolved at all.
 *
 * Deliberately indistinguishable: separate messages turn the boundary into a
 * name oracle. "could not be resolved" for `db` and "not allowed" for
 * `db.internal` tells a caller which of this instance's compose names exist.
 */
export const OUTBOUND_REFUSED_MESSAGE = "Outbound URL is not allowed";

/**
 * The address decision refused this URL. A distinct class, not a distinct
 * message: a consumer needs to tell "the boundary said no" from "the URL was
 * malformed" to decide whether a retry makes sense, and the *text* stays the
 * one answer so nothing about which name exists reaches whoever asked.
 */
export class OutboundAddressRefusedError extends OutboundGuardError {
  constructor() {
    super(422, OUTBOUND_REFUSED_MESSAGE);
    this.name = "OutboundAddressRefusedError";
  }
}

export function outboundRefused(): OutboundAddressRefusedError {
  return new OutboundAddressRefusedError();
}
