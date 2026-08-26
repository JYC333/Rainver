import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { VendorCliAdapterType } from "../../runtimeAdapters/specs.js";

export type SubscriptionRuntime = VendorCliAdapterType;

interface Lease {
  token: Buffer;
  runtime: SubscriptionRuntime;
  expires_at: number;
}

const HOSTS: Record<SubscriptionRuntime, readonly string[]> = {
  claude_code: ["anthropic.com", "claude.ai"],
  codex_cli: ["openai.com", "chatgpt.com"],
  opencode: ["opencode.ai"],
};

export class SubscriptionEgressLeaseRegistry {
  private readonly leases = new Map<string, Lease>();
  private baseUrl: string | null = null;

  setBaseUrl(value: string | null): void { this.baseUrl = value?.replace(/\/+$/, "") ?? null; }

  create(runtime: SubscriptionRuntime, ttlMs: number): { id: string; proxy_url: string } {
    this.prune();
    const id = randomUUID();
    const token = randomBytes(32);
    this.leases.set(id, { token, runtime, expires_at: Date.now() + Math.max(1_000, ttlMs) });
    // The non-routable fallback keeps deterministic unit/fake-executor paths
    // independent of server startup while still failing closed if accidentally
    // used for real I/O. Normal server startup replaces it with the internal
    // provider-proxy listener before any request is accepted.
    const url = new URL(this.baseUrl ?? "http://subscription-egress.invalid");
    url.username = id;
    url.password = token.toString("base64url");
    return { id, proxy_url: url.toString().replace(/\/$/, "") };
  }

  authorize(id: string, token: string, host: string, port: number): boolean {
    this.prune();
    const lease = this.leases.get(id);
    const actual = Buffer.from(token, "base64url");
    if (!lease || actual.length !== lease.token.length || !timingSafeEqual(actual, lease.token)) return false;
    if (port !== 443) return false;
    const normalized = host.toLowerCase().replace(/\.$/, "");
    return HOSTS[lease.runtime].some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
  }

  revoke(id: string): void { this.leases.delete(id); }

  private prune(): void {
    const now = Date.now();
    for (const [id, lease] of this.leases) if (lease.expires_at <= now) this.leases.delete(id);
  }
}

export const subscriptionEgressLeases = new SubscriptionEgressLeaseRegistry();
