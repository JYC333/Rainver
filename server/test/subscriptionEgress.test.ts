import { describe, expect, it } from "vitest";
import { SubscriptionEgressLeaseRegistry } from "../src/modules/providers/proxy/subscriptionEgress";

describe("SubscriptionEgressLeaseRegistry", () => {
  it("authorizes only the registered runtime's HTTPS host allowlist", () => {
    const registry = new SubscriptionEgressLeaseRegistry();
    registry.setBaseUrl("http://server:49152");
    const lease = registry.create("codex_cli", 30_000);
    const url = new URL(lease.proxy_url);
    expect(registry.authorize(url.username, url.password, "api.openai.com", 443)).toBe(true);
    expect(registry.authorize(url.username, url.password, "chatgpt.com", 443)).toBe(true);
    expect(registry.authorize(url.username, url.password, "postgres", 5432)).toBe(false);
    expect(registry.authorize(url.username, url.password, "evil-openai.com", 443)).toBe(false);
    registry.revoke(lease.id);
    expect(registry.authorize(url.username, url.password, "api.openai.com", 443)).toBe(false);
  });
});
