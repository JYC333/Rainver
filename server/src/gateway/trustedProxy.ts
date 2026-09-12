import { lookup } from "node:dns/promises";

export type ResolveAllAddresses = (hostname: string) => Promise<string[]>;

const defaultResolveAll: ResolveAllAddresses = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

/**
 * The one peer whose `X-Forwarded-*` headers this server believes: the
 * frontend proxy, named by its in-network hostname (`SERVER_TRUSTED_PROXY_HOST`).
 *
 * Named rather than addressed because a Compose service's IP changes when the
 * container is recreated. Everything else that can reach this server directly
 * — the built-in execution host and the Runs inside it, the deployer — is a
 * peer whose forwarded headers are ignored, so none of them can choose the
 * client address a per-IP limit keys on.
 *
 * A failed resolution clears the set rather than keeping the last one: an
 * address the proxy no longer holds may have been handed to another container.
 */
export class TrustedProxyAddresses {
  private addresses = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hostname: string,
    private readonly resolveAll: ResolveAllAddresses = defaultResolveAll,
    private readonly refreshMs = 30_000,
  ) {}

  trusts(address: string): boolean {
    return this.addresses.has(normalizeAddress(address));
  }

  async refresh(): Promise<void> {
    try {
      this.addresses = new Set((await this.resolveAll(this.hostname)).map(normalizeAddress));
    } catch {
      this.addresses = new Set();
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** A dual-stack socket reports an IPv4 peer as `::ffff:a.b.c.d`. */
function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") && address.includes(".") ? address.slice("::ffff:".length) : address;
}
