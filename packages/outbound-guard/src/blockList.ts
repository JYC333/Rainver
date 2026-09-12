import { BlockList, isIP } from "node:net";

/**
 * Every network an outbound request must never reach: this instance's own
 * containers, the machine itself, and the metadata service that hands out
 * cloud credentials.
 *
 * `net.BlockList` rather than string matching, because an address has many
 * spellings and a boundary that only recognises the canonical one is not a
 * boundary. `::ffff:7f00:1`, `0:0:0:0:0:0:0:1` and `127.0.0.1` are the same
 * host; the first two are what a caller writes when it does not want to be
 * recognised. BlockList parses rather than compares, and folds IPv4-mapped
 * IPv6 onto the IPv4 rules — which is also why `::ffff:0:0/96` must *not* be
 * added as a range of its own: BlockList maps an IPv4 check into that prefix,
 * so listing it would refuse every IPv4 address there is. `::ffff:10.0.0.5` is
 * already refused by the `10.0.0.0/8` rule.
 *
 * This is the one list. The host daemon's egress proxy and the control plane's
 * own outbound fetches both judge by it, so a range added here closes both at
 * once — they used to be two copies kept in step by a comment.
 */
function buildBlockList(): BlockList {
  const list = new BlockList();
  // RFC 1918, loopback, link-local (which includes 169.254.169.254), "this
  // network", carrier-grade NAT, benchmarking, multicast, broadcast, and the
  // reserved 192.0.0.0/24.
  for (const [address, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10],
    ["198.18.0.0", 15], ["192.0.0.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(address, prefix);
  }
  // Loopback, unspecified, unique-local, link-local, the deprecated site-local
  // range, IPv6 multicast, and the IPv6 metadata address some providers serve.
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("fec0::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  list.addSubnet("fd00:ec2::", 32, "ipv6");
  // Every IPv6 spelling that carries an IPv4 address inside it. Each of these
  // reaches an IPv4 destination through a translator or a tunnel, so checking
  // only the IPv4 rules leaves the same private address reachable under
  // another name: `::7f00:1`, `64:ff9b::7f00:1` and `2002:7f00:1::` all end up
  // at 127.0.0.1 wherever the corresponding mechanism is configured.
  //
  //   ::/96          IPv4-compatible (deprecated), and `::` and `::1` with it
  //   64:ff9b::/96   NAT64 well-known prefix, and 64:ff9b:1::/48 for local use
  //   2002::/16      6to4
  //   2001::/32      Teredo
  for (const [address, prefix] of [
    ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
    ["2002::", 16], ["2001::", 32],
  ] as const) {
    list.addSubnet(address, prefix, "ipv6");
  }
  return list;
}

const BLOCKED = buildBlockList();

function buildLoopbackList(): BlockList {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8);
  list.addAddress("::1", "ipv6");
  // IPv4-mapped loopback, for a caller that writes `::ffff:127.0.0.1`.
  list.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
  return list;
}

const LOOPBACK = buildLoopbackList();

/**
 * Whether an address is inside this instance's own network, in any spelling.
 *
 * Judged on the *resolved* address rather than the name, because a public name
 * can resolve to a private address — which is exactly how a request reaches a
 * sibling service.
 *
 * **Fails closed.** Anything this cannot parse as an address is treated as
 * blocked, not as fine: an empty host resolves to `null`, and a block list
 * that answers "not blocked" for what it does not understand is a block list
 * pointed the wrong way. `CONNECT []:PORT` reached loopback through exactly
 * that gap and was recorded as allowed.
 */
/**
 * Whether an address is this machine itself.
 *
 * A narrower question than `isBlockedAddress`, and asked for a different
 * reason: plain HTTP is acceptable when the packets never leave the machine.
 * Judged as an address, never as a name — `startsWith("127.")` is true of
 * `127.evil.com`, which is a hostname somebody else controls.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (typeof address !== "string" || address === "") return false;
  const version = isIP(address);
  if (version !== 0) return LOOPBACK.check(address, version === 6 ? "ipv6" : "ipv4");
  // `127.1` and `127.0.1` are not addresses `isIP` accepts, but `getaddrinfo`
  // resolves them to 127.0.0.1 and they are what somebody types. Digits and
  // dots only, so this still cannot admit a hostname: `127.evil.com` has
  // letters in it and is refused.
  return /^127(?:\.\d{1,3}){0,3}$/.test(address);
}

export function isBlockedAddress(address: string | null | undefined): boolean {
  if (typeof address !== "string" || address === "") return true;
  const version = isIP(address);
  if (version === 0) return true;
  return BLOCKED.check(address, version === 6 ? "ipv6" : "ipv4");
}
