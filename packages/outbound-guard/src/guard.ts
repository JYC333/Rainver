import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isBlockedAddress } from "./blockList.js";
import { OutboundGuardError, outboundRefused } from "./errors.js";

/** One address a request is allowed to connect to, and the family to dial it as. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export type AddressLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/** How long a name resolution may take before the fetch is refused. */
export const DEFAULT_DNS_TIMEOUT_MS = 5_000;

/**
 * Decides which addresses an outbound request may connect to.
 *
 * The address, not the name, is the decision — and the *same* address is then
 * what the connection is pinned to. Checking a name and letting the HTTP client
 * resolve it again is a race a hostile DNS server wins by answering twice:
 * public for the check, private for the connect.
 *
 * Tests that must reach a fixture server supply their own implementation rather
 * than loosening this one; there is no bypass in the production guard.
 */
export interface OutboundGuard {
  /**
   * `signal` is the whole fetch's budget. Resolution runs under it as well as
   * under the guard's own DNS timeout, so a chain of redirects cannot spend a
   * fresh DNS timeout per hop past a deadline that has already passed.
   */
  pin(url: URL, signal?: AbortSignal): Promise<readonly PinnedAddress[]>;
}

export function parseOutboundHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OutboundGuardError(422, "Outbound URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new OutboundGuardError(422, "Outbound URL must be a valid HTTP(S) URL");
  }
  if (parsed.username || parsed.password) {
    throw new OutboundGuardError(422, "Outbound URL must not include credentials");
  }
  if (!parsed.hostname) {
    throw new OutboundGuardError(422, "Outbound URL must be a valid HTTP(S) URL");
  }
  return parsed;
}

/** `[::1]` is how a URL spells an IPv6 literal; the brackets are not part of the address. */
export function urlHostAddress(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(outboundRefused()), timeoutMs);
        if (!signal) return;
        if (signal.aborted) { reject(signal.reason as Error); return; }
        onAbort = () => reject(signal.reason as Error);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

export const dnsAddressLookup: AddressLookup = (hostname) => dnsLookup(hostname, { all: true });

/**
 * The production guard: resolve the name, refuse it if any answer is inside
 * this instance's own network, and pin the rest.
 *
 * *Any*, not *all*: a name with one public and one private answer is a
 * rebinding attempt with the second answer already loaded.
 */
export function createOutboundGuard(
  options: { lookup?: AddressLookup; dnsTimeoutMs?: number } = {},
): OutboundGuard {
  const lookup = options.lookup ?? dnsAddressLookup;
  // A resolver that never answers would otherwise hold a scan worker for as
  // long as the operating system's own retry schedule, which is minutes.
  const dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  return {
    async pin(url, signal) {
      const host = urlHostAddress(url);
      const literal = isIP(host);
      if (literal !== 0) {
        if (isBlockedAddress(host)) throw outboundRefused();
        return [{ address: host, family: literal === 6 ? 6 : 4 }];
      }
      let answers: Array<{ address: string; family: number }>;
      try {
        answers = await withTimeout(lookup(host), dnsTimeoutMs, signal);
      } catch (error) {
        if (error instanceof OutboundGuardError) throw error;
        // A budget that ran out is not an address decision. Folding it into the
        // refusal would persist a deadline as `failure_kind: "network"`, which
        // is the conflation of "answered slowly" with "could not be reached"
        // that `sourceConnectionFetch` exists to keep apart. The block-list and
        // unresolvable cases still answer alike; only this one is let through
        // as the timeout it is.
        if (signal?.aborted) throw error;
        throw outboundRefused();
      }
      if (answers.length === 0) throw outboundRefused();
      if (answers.some((entry) => isBlockedAddress(entry.address))) throw outboundRefused();
      return answers.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
    },
  };
}
