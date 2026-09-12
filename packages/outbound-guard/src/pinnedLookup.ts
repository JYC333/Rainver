import type { PinnedAddress } from "./guard.js";

type LookupAllCallback = (error: Error | null, addresses: Array<{ address: string; family: number }>) => void;
type LookupOneCallback = (error: Error | null, address: string, family: number) => void;

/**
 * A `dns.lookup`-shaped function that answers with addresses the guard already
 * checked, ignoring the name.
 *
 * This is what closes the rebinding race. The guard resolving a name proves
 * nothing if the HTTP client then resolves it again — a hostile resolver
 * answers public for the check and private for the connect. Handing the client
 * this instead means the socket goes to the address that was judged, while TLS
 * still validates against the real hostname, so nothing about certificate
 * checking is weakened.
 */
export function pinnedAddressLookup(pinned: readonly PinnedAddress[]) {
  return (
    _hostname: string,
    // `family` is `4 | 6 | 0` or the spelled-out `"IPv4"`/`"IPv6"`, depending on
    // which of Node's overloads the caller reached.
    options: { all?: boolean; family?: number | "IPv4" | "IPv6" } | undefined,
    callback: LookupAllCallback | LookupOneCallback,
  ): void => {
    const family = options?.family === "IPv4" ? 4 : options?.family === "IPv6" ? 6 : options?.family;
    const wanted = family === 4 || family === 6
      ? pinned.filter((entry) => entry.family === family)
      : pinned;
    // An empty answer for the requested family is reported as a resolution
    // failure rather than silently falling back to the other family, which
    // would connect over a transport the caller did not ask for.
    if (wanted.length === 0) {
      const error = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      if (options?.all === false) (callback as LookupOneCallback)(error, "", 0);
      else (callback as LookupAllCallback)(error, []);
      return;
    }
    if (options?.all === false) {
      const first = wanted[0]!;
      (callback as LookupOneCallback)(null, first.address, first.family);
      return;
    }
    (callback as LookupAllCallback)(null, wanted.map((entry) => ({ address: entry.address, family: entry.family })));
  };
}
