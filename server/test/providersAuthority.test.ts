/**
 * Provider-read authority path: list/detail/catalog served by the control
 * plane behind native identity. Uses fake DB/auth ports; PostgreSQL access is
 * covered by integration and stack smoke checks.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import {
  __setProvidersDbPortForTests,
  mapProviderRowToDto,
  type ProvidersDbPort,
} from "../src/modules/providers/dbReader";
import {
  __setAuthIdentityForTests,
  __setAuthRepositoryForTests,
  type AuthRepository,
} from "../src/modules/auth";

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
    SERVER_DATABASE_URL: "postgresql://server_ro@db:5432/agent_space",
  });
}

describe("providers read authority", () => {
  it("maps legacy custom-provider rows onto the vendor vocabulary", () => {
    expect(mapProviderRowToDto({
      id: "legacy-custom",
      space_id: "space-1",
      name: "Legacy custom endpoint",
      provider_type: "other",
      base_url: "https://gateway.example.test/v1",
      network_profile_id: null,
      default_model: "custom-model",
      enabled: true,
      credential_id: "credential-1",
      capabilities_json: { models: ["custom-model"] },
      config_json: {},
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    })).toMatchObject({
      provider_type: "openai_compatible",
      base_url: "https://gateway.example.test/v1",
    });
  });

  it("serves list and detail from the DB port scoped by native server identity", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProvidersDbPortForTests(
      fakeDb({ "space-1": [provider("mp-2"), provider("mp-1")] }),
    );
    app = buildServer(providerRoutesConfig(), { logger: false });

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
    app = buildServer(providerRoutesConfig(), { logger: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/providers/mp-missing" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ detail: "ModelProvider 'mp-missing' not found" });
  });

  it("passes native identity denials through unchanged", async () => {
    __setAuthRepositoryForTests(denyingAuth());
    __setProvidersDbPortForTests(fakeDb({ "space-1": [provider("mp-1")] }));
    app = buildServer(providerRoutesConfig(), { logger: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ detail: "Authentication required" });
  });

  it("serves the catalog constant and litellm-providers from static catalogs", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProvidersDbPortForTests(fakeDb({}));
    app = buildServer(providerRoutesConfig(), { logger: false });

    // Dynamic import: the typecheck runs this CJS test against the ESM package.
    const { PROVIDER_CATALOG_INFO } = await import("@agent-space/protocol");
    const catalog = await app.inject({ method: "GET", url: "/api/v1/providers/catalog" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual(PROVIDER_CATALOG_INFO);

    const litellm = await app.inject({
      method: "GET",
      url: "/api/v1/providers/litellm-providers",
    });
    expect(litellm.statusCode).toBe(200);
    expect(litellm.headers["x-upstream"]).toBeUndefined();
    expect(litellm.json()).toEqual([
      "openai",
      "anthropic",
      "minimax",
      "openrouter",
      "deepseek",
      "ollama",
      "openai_compatible",
    ]);

    const presets = await app.inject({ method: "GET", url: "/api/v1/providers/presets" });
    expect(presets.statusCode).toBe(200);
    expect(presets.json().map((preset: { id: string }) => preset.id)).toEqual(
      expect.arrayContaining(["cohere_embedding", "cohere_rerank", "minimax"]),
    );
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
    app = buildServer(providerRoutesConfig(), { logger: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("providers_db_unavailable");
    expect(res.payload).not.toContain("hunter2");
  });

  it("advertises the provider read authority feature", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProvidersDbPortForTests(fakeDb({}));
    app = buildServer(providerRoutesConfig(), { logger: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/server/features" });
    const features = res.json().features as string[];
    expect(features).toContain("providers_read_server_authority");
  });
});
