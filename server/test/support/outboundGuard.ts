import { isIP } from "node:net";
import { createOutboundGuard, type OutboundGuard } from "@rainver/outbound-guard";

/**
 * Outbound boundaries for tests.
 *
 * The production guard resolves a name and refuses every address inside this
 * instance's own network — which is exactly what a test cannot have, because a
 * test's upstream is either a loopback fixture server or a `.test` name that
 * resolves nowhere. So a test injects its own boundary rather than the
 * production code offering a way to switch its own off: there is no bypass in
 * `createOutboundGuard`, and a caller that passes nothing gets the strict one.
 */

/**
 * Pins a fixture server on loopback.
 *
 * A name is pinned to 127.0.0.1, so a test can use a hostname the production
 * guard would refuse to resolve and still reach its own server — and the
 * connection proves the pinning path, because nothing resolves that name.
 */
export const fixtureServerGuard: OutboundGuard = {
  // No signal handling: nothing here resolves anything, so there is no wait for
  // the fetch's budget to interrupt.
  pin: async (url) => {
    const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
    const literal = isIP(host);
    if (literal !== 0) return [{ address: host, family: literal === 6 ? 6 : 4 }];
    return [{ address: "127.0.0.1", family: 4 }];
  },
};

/**
 * The production guard with DNS replaced by one public answer.
 *
 * For a test whose `fetch` is stubbed: the block list still applies, so a
 * loopback or metadata URL is still refused, but no `.test` name has to resolve.
 */
export const publicAddressGuard: OutboundGuard = createOutboundGuard({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
});
