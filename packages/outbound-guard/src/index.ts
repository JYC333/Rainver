export { isBlockedAddress, isLoopbackAddress, isSyntheticDnsAddress } from "./blockList.js";
export {
  OUTBOUND_REFUSED_MESSAGE,
  OutboundAddressRefusedError,
  OutboundGuardError,
  outboundRefused,
} from "./errors.js";
export {
  dnsAddressLookup,
  createOutboundGuard,
  DEFAULT_DNS_TIMEOUT_MS,
  parseOutboundHttpUrl,
  urlHostAddress,
  type AddressLookup,
  type OutboundGuard,
  type PinnedAddress,
} from "./guard.js";
export { pinnedAddressLookup } from "./pinnedLookup.js";
export { decodeTruncatedUtf8 } from "./body.js";
export {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_OUTBOUND_DEADLINE_MS,
  guardedFetch,
  undiciPinnedFetch,
  type GuardedRequest,
  type GuardedResponse,
  type PinnedFetch,
  type PinnedFetchInit,
} from "./fetch.js";
