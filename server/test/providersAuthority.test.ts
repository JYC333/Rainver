/**
 * Provider-read authority path: list/detail/catalog served by the control
 * plane behind native identity. Uses fake DB/auth ports; PostgreSQL access is
 * covered by integration and stack smoke checks.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { systemModule } from "../src/modules/system/index.js";
import { providersModule } from "../src/modules/providers/index.js";
import { loadConfig } from "../src/config.js";
import {
  __setProvidersDbPortForTests,
  type ProvidersDbPort,
} from "../src/modules/providers/dbReader.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository } from "../src/modules/auth/identity.js";

let app: FastifyInstance;

afterEach(async () => {
  __setProvidersDbPortForTests(null);
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
  await app?.close();
});

function provider(id: string, spaceId = "space-1") {
  return {
    id,
    space_id: spaceId,
    name: "Main",
    provider_type: "openai",
    base_url: "https://api.openai.com/v1",
    claude_compatible_base_url: null,
    openai_compatible_base_url: "https://api.openai.com/v1",
    default_model: "gpt-4o",
    available_models: ["gpt-4o"],
    enabled: true,
    is_default: true,
    has_api_key: true,
    created_at: "2026-06-11T12:00:00.000Z",
    updated_at: "2026-06-11T12:00:00.000Z",
  };
}

function fakeDb(rowsBySpace: Record<string, ReturnType<typeof provider>[]>): ProvidersDbPort {
  return {
    async listProviders(spaceId) {
      return rowsBySpace[spaceId] ?? [];
    },
    async getProvider(spaceId, _userId, configId) {
      return (rowsBySpace[spaceId] ?? []).find((r) => r.id === configId) ?? null;
    },
  };
}

function denyingAuth(): AuthRepository {
  return {
    async resolveIdentity() {
      return {
        ok: false,
        reason: "denied",
        statusCode: 401,
        body: JSON.stringify({ detail: "Authentication required" }),
      };
    },
    async getCurrentUser() {
      throw new Error("not used");
    },
    async getUserSpaces() {
      throw new Error("not used");
    },
    async getSpaceForUser() {
      throw new Error("not used");
    },
    async logout() {
      throw new Error("not used");
    },
    async findOrCreateFromGoogle() {
      throw new Error("not used");
    },
    async createSession() {
      throw new Error("not used");
    },
  };
}

function providerRoutesConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server_ro@db:5432/rainver",
  });
}

describe("providers read authority", () => {
  it("serves list and detail from the DB port scoped by native server identity", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProvidersDbPortForTests(
      fakeDb({ "space-1": [provider("mp-2"), provider("mp-1")] }),
    );
    app = buildModuleServer(providerRoutesConfig(), [providersModule, systemModule]);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/providers?space_id=space-1",
      headers: { cookie: "session_id=abc" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((r: { id: string }) => r.id)).toEqual(["mp-2", "mp-1"]);

    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/providers/mp-1?space_id=space-1",
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe("mp-1");
  });

  it("returns the public 404 detail for a missing provider", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProvidersDbPortForTests(fakeDb({ "space-1": [] }));
    app = buildModuleServer(providerRoutesConfig(), [providersModule, systemModule]);

    const res = await app.inject({ method: "GET", url: "/api/v1/providers/mp-missing" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ detail: "ModelProvider 'mp-missing' not found" });
  });

  it("passes native identity denials through unchanged", async () => {
    __setAuthRepositoryForTests(denyingAuth());
    __setProvidersDbPortForTests(fakeDb({ "space-1": [provider("mp-1")] }));
    app = buildModuleServer(providerRoutesConfig(), [providersModule, systemModule]);

    const res = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ detail: "Authentication required" });
  });

  it("serves the vendor registry, and no longer serves the retired catalog routes", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProvidersDbPortForTests(fakeDb({}));
    app = buildModuleServer(providerRoutesConfig(), [providersModule, systemModule]);

    const vendors = await app.inject({ method: "GET", url: "/api/v1/providers/vendors" });
    expect(vendors.statusCode).toBe(200);
    expect(vendors.headers["x-upstream"]).toBeUndefined();
    // Bind the response to the published contract, not to a literal here.
    const { ProviderVendorListResponseSchema } = await import("@rainver/protocol");
    const body = ProviderVendorListResponseSchema.parse(vendors.json());
    // The client reads these facts instead of keeping its own copy.
    expect(body).toContainEqual({
      id: "deepseek",
      display_name: "DeepSeek",
      protocol: "openai_completions",
      supports_chat: true,
      supports_runtime_tools: true,
      supports_structured_output: true,
      supports_embedding: false,
      supports_rerank: false,
      default_base_url: "https://api.deepseek.com",
      api_key_required: true,
      subscription_only: false,
    });
    expect(body.some((vendor) => vendor.id === "openai_codex" && vendor.subscription_only === true)).toBe(true);
    expect(body.every((vendor) => !("api_key" in vendor) && !("secret_ref" in vendor))).toBe(true);

    // `/presets` is the surviving static sibling and must stay claimed.
    const presets = await app.inject({ method: "GET", url: "/api/v1/providers/presets" });
    expect(presets.statusCode).toBe(200);
    expect((presets.json() as Array<{ id: string }>).map((preset) => preset.id)).toEqual(
      expect.arrayContaining(["cohere_embedding", "cohere_rerank", "minimax"]),
    );

    // The retired names are no longer claimed as static siblings, so they now
    // match the provider-detail parametric route and 404 as unknown provider
    // ids. That is the same answer any unknown id gets — deliberately not a
    // special case for two deleted names, which would be a compatibility alias
    // wearing a different hat.
    for (const url of ["/api/v1/providers/catalog", "/api/v1/providers/litellm-providers"]) {
      const retired = await app.inject({ method: "GET", url });
      expect(retired.statusCode, url).toBe(404);
      expect(retired.json(), url).toMatchObject({ detail: expect.stringContaining("not found") });
    }
  });

  it("answers 503 when the DB read fails, without leaking the error", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProvidersDbPortForTests({
      async listProviders() {
        throw new Error("connection refused at db:5432 password=hunter2");
      },
      async getProvider() {
        return null;
      },
    });
    app = buildModuleServer(providerRoutesConfig(), [providersModule, systemModule]);

    const res = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("providers_db_unavailable");
    expect(res.payload).not.toContain("hunter2");
  });

  it("advertises the provider read authority feature", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProvidersDbPortForTests(fakeDb({}));
    app = buildModuleServer(providerRoutesConfig(), [providersModule, systemModule]);

    const res = await app.inject({ method: "GET", url: "/api/v1/server/features" });
    const features = res.json().features as string[];
    expect(features).toContain("providers_read_server_authority");
  });
});
