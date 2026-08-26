import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildModuleServer } from "./support/moduleServer.js";
import { providersModule } from "../src/modules/providers/index.js";
import { loadConfig } from "../src/config.js";
import { __setProviderCommandStoreForTests, type ProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { __setProviderHttpClientForTests } from "../src/modules/providers/invocation/invocation.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { resolveTestUsageAttribution } from "./support/usageAttribution.js";

let app: FastifyInstance;
let tempHome: string | undefined;

afterEach(async () => {
  __setProviderCommandStoreForTests(null);
  __setProviderHttpClientForTests(null);
  __setAuthIdentityForTests(null);
  await app?.close();
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

function providerDto(overrides: Record<string, unknown> = {}) {
  return {
    id: "provider-1",
    space_id: "space-1",
    name: "Main",
    provider_type: "openai",
    base_url: "https://api.openai.com/v1",
    claude_compatible_base_url: null,
    openai_compatible_base_url: "https://api.openai.com/v1",
    default_model: "gpt-4o-mini",
    available_models: ["gpt-4o-mini"],
    enabled: true,
    is_default: true,
    has_api_key: true,
    created_at: "2026-06-11T12:00:00.000Z",
    updated_at: "2026-06-11T12:00:00.000Z",
    ...overrides,
  };
}

function fakeStore(): ProviderCommandStore {
  return {
    async createProvider(_spaceId, _userId, input) {
      return providerDto({ name: input.name, provider_type: input.provider_type });
    },
    async updateProvider(_spaceId, _userId, providerId, input) {
      return providerDto({ id: providerId, name: input.name ?? "Main" });
    },
    async deleteProvider(_spaceId, _userId, _providerId) {
    },
    async grantProviderToSpace(_spaceId, _userId, providerId, input) {
      return {
        id: "grant-1",
        provider_id: providerId,
        space_id: input.space_id,
        owner_user_id: "user-1",
        granted_by_user_id: "user-1",
        enabled: input.enabled ?? true,
        is_default: input.is_default ?? false,
        network_profile_id: input.network_profile_id ?? null,
        created_at: "2026-06-11T12:00:00.000Z",
        updated_at: "2026-06-11T12:00:00.000Z",
      };
    },
    async revokeProviderGrant(_spaceId, _userId, _providerId, _grantSpaceId) {
    },
    async getInvocationTarget(_spaceId, providerId) {
      return {
        provider: {
          id: providerId ?? "provider-1",
          space_id: "space-1",
          name: "Main",
          provider_type: "openai",
          base_url: "https://api.example.test/v1",
          network_profile_id: null,
          default_model: "gpt-4o-mini",
          available_models: ["gpt-4o-mini"],
          enabled: true,
          is_default: true,
        },
        network_profile: null,
        rotation_strategy: "fill_first",
        fallback_provider_ids: [],
        candidates: [
          { member_id: "member-1", credential_id: "credential-1", api_key: "sk-test-provider" },
        ],
      };
    },
    async recordPoolOutcome(_memberId, _outcome) {
    },
    resolveUsageAttribution: resolveTestUsageAttribution,
    async recordUsageObservation(_input) {
    },
    async resolveProviderApiKey(_spaceId, providerId) {
      return "sk-test-provider";
    },
    async listPool(_spaceId, providerId) {
      return {
        provider_id: providerId,
        rotation_strategy: "fill_first",
        fallback_provider_ids: [],
        members: [],
      };
    },
    async addPoolCredential(_spaceId, _userId, providerId, input) {
      return {
        id: "member-2",
        credential_id: "credential-2",
        name: input.name ?? "pool key",
        position: 1,
        enabled: true,
        healthy: true,
        cooldown_until: null,
        last_failure_class: null,
        request_count: 0,
        failure_count: 0,
        last_used_at: null,
        created_at: "2026-06-11T12:00:00.000Z",
        updated_at: "2026-06-11T12:00:00.000Z",
      };
    },
    async removePoolCredential(_spaceId, _userId, _providerId, _memberId) {
    },
    async updatePoolConfig(_spaceId, _userId, providerId, input) {
      return {
        provider_id: providerId,
        rotation_strategy: input.rotation_strategy ?? "fill_first",
        fallback_provider_ids: input.fallback_provider_ids ?? [],
        members: [],
      };
    },
    async getTaskChain(_spaceId, _task) {
      return null;
    },
    async listTaskPolicies(_spaceId) {
      return [];
    },
    async putTaskPolicy(_spaceId, _userId, task, chain, enabled) {
      return { task, chain, enabled: enabled ?? true, updated_at: "2026-06-11T12:00:00.000Z" };
    },
    async deleteTaskPolicy(_spaceId, _userId, _task) {
    },
    async resolveCredentialApiKey(_spaceId, _credentialId) {
      return "sk-test-credential";
    },
    async listConfiguredModels(_spaceId, _providerId) {
      return ["gpt-4o-mini"];
    },
    async recordCliCredentialUsage(_input) {
      return "event-1";
    },
  };
}

async function authorityConfig() {
  tempHome = await mkdtemp(join(tmpdir(), "aspace-server-"));
  return loadConfig({
    SERVER_INTERNAL_TOKEN: "internal-token",
    AGENT_SPACE_HOME: tempHome,
  });
}

describe("providers and credentials server authority", () => {
  it("serves provider commands with native identity response shape", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProviderCommandStoreForTests(fakeStore());
    app = buildModuleServer(await authorityConfig(), [providersModule]);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/providers?space_id=space-1",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        name: "Main",
        provider_type: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "request-only",
        default_model: "gpt-4o-mini",
        is_default: true,
      }),
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ name: "Main", has_api_key: true });
    expect(create.payload).not.toContain("request-only");

    const supported = await app.inject({
      method: "GET",
      url: "/api/v1/providers/vendors?space_id=space-1",
    });
    expect(supported.statusCode).toBe(200);
    expect((supported.json() as Array<{ id: string }>).map((vendor) => vendor.id)).toContain("anthropic");

    const presetCreate = await app.inject({
      method: "POST",
      url: "/api/v1/providers/from-preset?space_id=space-1",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        preset_id: "minimax",
        api_key: "request-only-preset",
        name: "MiniMax Test",
      }),
    });
    expect(presetCreate.statusCode).toBe(201);
    expect(presetCreate.json().provider).toMatchObject({
      name: "MiniMax Test",
      provider_type: "minimax",
    });
    expect(presetCreate.payload).not.toContain("request-only-preset");
  });

  it("serves the credential pool and task-policy surfaces", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProviderCommandStoreForTests(fakeStore());
    app = buildModuleServer(await authorityConfig(), [providersModule]);

    const pool = await app.inject({
      method: "GET",
      url: "/api/v1/providers/provider-1/credentials?space_id=space-1",
    });
    expect(pool.statusCode).toBe(200);
    expect(pool.json()).toMatchObject({ provider_id: "provider-1", rotation_strategy: "fill_first" });

    const added = await app.inject({
      method: "POST",
      url: "/api/v1/providers/provider-1/credentials?space_id=space-1",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ api_key: "sk-pool-request-only", name: "backup key" }),
    });
    expect(added.statusCode).toBe(201);
    expect(added.payload).not.toContain("sk-pool-request-only");

    const config = await app.inject({
      method: "PATCH",
      url: "/api/v1/providers/provider-1/credentials/config?space_id=space-1",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ rotation_strategy: "round_robin" }),
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({ rotation_strategy: "round_robin" });

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/providers/provider-1/credentials/member-2?space_id=space-1",
    });
    expect(removed.statusCode).toBe(204);

    // Static sibling: task-policies must not be swallowed by /:configId.
    const policies = await app.inject({
      method: "GET",
      url: "/api/v1/providers/task-policies?space_id=space-1",
    });
    expect(policies.statusCode).toBe(200);
    expect(policies.json()).toEqual([]);

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/task-policies/reflector?space_id=space-1",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ chain: [{ provider_id: "provider-1", model: "gpt-4o-mini" }] }),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ task: "reflector" });
  });

  it("owns CLI methods, status, and internal credential resolution", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProviderCommandStoreForTests(fakeStore());
    app = buildModuleServer(await authorityConfig(), [providersModule]);

    const methods = await app.inject({
      method: "GET",
      url: "/api/v1/credentials/cli/methods?space_id=space-1",
    });
    expect(methods.statusCode).toBe(200);
    expect(
      methods.json().find((row: { runtime: string }) => row.runtime === "claude_code"),
    ).toMatchObject({
      method: "cli",
      supports_cli: true,
    });
    expect(
      methods.json().find((row: { runtime: string }) => row.runtime === "codex_cli"),
    ).toMatchObject({
      method: "cli",
      supports_cli: true,
    });

    const legacyProfile = await app.inject({
      method: "GET",
      url: "/api/v1/credentials/cli/profiles/codex_cli/default?space_id=space-1",
    });
    expect(legacyProfile.statusCode).toBe(404);

    const available = await app.inject({
      method: "GET",
      url: "/api/v1/credentials/cli/available?runtime=codex_cli&space_id=space-1",
    });
    expect(available.statusCode).toBe(200);
    expect(available.json()).toEqual([]);

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/credentials/cli/status?space_id=space-1",
    });
    expect(status.statusCode).toBe(200);
    expect(
      status.json().find((row: { runtime: string }) => row.runtime === "codex_cli"),
    ).toMatchObject({ logged_in: false, profile_id: null });

    const denied = await app.inject({
      method: "POST",
      url: "/internal/providers-credentials/credentials/runtime/resolve",
      payload: JSON.stringify({
        kind: "model_provider_api_key",
        space_id: "space-1",
        provider_id: "provider-1",
      }),
    });
    expect(denied.statusCode).toBe(401);

    const resolved = await app.inject({
      method: "POST",
      url: "/internal/providers-credentials/credentials/runtime/resolve",
      headers: {
        "content-type": "application/json",
        "x-agent-space-internal-token": "internal-token",
      },
      payload: JSON.stringify({
        kind: "model_provider_api_key",
        space_id: "space-1",
        provider_id: "provider-1",
      }),
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({
      kind: "model_provider_api_key",
      provider_id: "provider-1",
      api_key: "sk-test-provider",
    });

    const resolvedCredential = await app.inject({
      method: "POST",
      url: "/internal/providers-credentials/credentials/runtime/resolve",
      headers: {
        "content-type": "application/json",
        "x-agent-space-internal-token": "internal-token",
      },
      payload: JSON.stringify({
        kind: "credential_api_key",
        space_id: "space-1",
        credential_id: "credential-1",
      }),
    });
    expect(resolvedCredential.statusCode).toBe(200);
    expect(resolvedCredential.json()).toEqual({
      kind: "credential_api_key",
      credential_id: "credential-1",
      api_key: "sk-test-credential",
    });
  });
});
