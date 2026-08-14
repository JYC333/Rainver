import { describe, it, expect } from "vitest";
import {
  IdentityIntrospectionResponseSchema,
  MODEL_PROVIDERS_READ_COLUMNS,
  MODEL_PROVIDERS_TABLE,
} from "../src/index";

describe("identity introspection contract", () => {
  it("parses the introspection response", () => {
    const parsed = IdentityIntrospectionResponseSchema.parse({
      space_id: "space-1",
      user_id: "user-1",
    });
    expect(parsed.space_id).toBe("space-1");
    expect(parsed.user_id).toBe("user-1");
  });

  it("rejects token/session/secret material on the identity port", () => {
    const base = { space_id: "space-1", user_id: "user-1" };
    expect(
      IdentityIntrospectionResponseSchema.safeParse({ ...base, token: "tok" }).success,
    ).toBe(false);
    expect(
      IdentityIntrospectionResponseSchema.safeParse({ ...base, session_id: "sess" }).success,
    ).toBe(false);
    expect(
      IdentityIntrospectionResponseSchema.safeParse({ ...base, api_key: "sk-leak" }).success,
    ).toBe(false);
    expect(IdentityIntrospectionResponseSchema.safeParse({ space_id: "s" }).success).toBe(false);
  });
});

describe("provider DB read allowlist", () => {
  it("pins the table and the exact column set the server reader may SELECT", () => {
    expect(MODEL_PROVIDERS_TABLE).toBe("model_providers");
    // Pins the model_providers columns exposed through the server read model.
    expect([...MODEL_PROVIDERS_READ_COLUMNS].sort()).toEqual(
      [
        "id",
        "space_id",
        "owner_user_id",
        "name",
        "provider_type",
        "base_url",
        "network_profile_id",
        "default_model",
        "enabled",
        "credential_id",
        "capabilities_json",
        "config_json",
        "created_at",
        "updated_at",
      ].sort(),
    );
  });
});
