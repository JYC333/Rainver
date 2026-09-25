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
  isSyntheticDnsHostnameRoute,
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
  createUndiciProxyFetch,
  undiciPinnedFetch,
  type GuardedRequest,
  type GuardedResponse,
  type GuardedStreamSink,
  type PinnedFetch,
  type PinnedFetchInit,
} from "./fetch.js";
