import { describe, expect, it } from "vitest";
import {
  effectiveProviderDefault,
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
} from "../src/modules/providers/eligibility";

const base = {
  provider_enabled: true,
  provider_grant_enabled: true,
  provider_owner_user_id: "owner-1",
  provider_credential_type: "api_key",
  provider_has_eligible_credential: true,
};

describe("provider eligibility", () => {
  it("requires a chat-capable provider and an active credential path", () => {
    expect(isProviderEligibleForUser({ ...base, provider_type: "openai" }, "member-1")).toBe(true);
    expect(isProviderEligibleForUser({ ...base, provider_type: "cohere" }, "member-1")).toBe(false);
    expect(isProviderEligibleForUser({ ...base, provider_type: "openai", provider_has_eligible_credential: false }, "member-1")).toBe(false);
  });

  it("keeps subscription providers owner-scoped while allowing keyless chat vendors", () => {
    expect(isProviderEligibleForUser({
      ...base,
      provider_type: "openai_codex",
      provider_credential_type: "subscription_oauth",
    }, "owner-1")).toBe(true);
    expect(isProviderEligibleForUser({
      ...base,
      provider_type: "openai_codex",
      provider_credential_type: "subscription_oauth",
    }, "member-1")).toBe(false);
    expect(isProviderEligibleForUser({
      ...base,
      provider_type: "ollama",
      provider_credential_type: null,
      provider_has_eligible_credential: false,
    }, "member-1")).toBe(true);
  });

  it("requires active grant and provider state", () => {
    expect(isProviderEligibleForUser({ ...base, provider_type: "openai", provider_grant_enabled: false }, "member-1")).toBe(false);
    expect(isProviderEligibleForUser({ ...base, provider_type: "openai", provider_enabled: false }, "member-1")).toBe(false);
  });

  it("uses the grant default when present and profile default otherwise", () => {
    expect(effectiveProviderDefault(true, false)).toBe(true);
    expect(effectiveProviderDefault(false, true)).toBe(true);
    expect(effectiveProviderDefault(false, false)).toBe(false);
    expect(effectiveProviderDefault(null, true)).toBe(true);
  });

  it("builds the same pool/primary credential predicate for every SQL caller", () => {
    const sql = providerCredentialEligibilitySql("provider.id", "provider.credential_id", "provider_credential");
    expect(sql).toContain("credential.credential_type = 'subscription_oauth'");
    expect(sql).toContain("credential.healthy = true");
    expect(sql).toContain("credential.cooldown_until <= now()");
    expect(sql).toContain("enrolled.credential_id = provider.credential_id");
  });
});
