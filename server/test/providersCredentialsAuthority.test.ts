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
    async authorizeCredentialSpend() {
      return {} as never;
    },
    async getInvocationTarget(_spaceId, providerId) {
      return {
        provider: {
          id: providerId ?? "provider-1",
          space_id: "space-1",
          home_space_id: "space-1",
          name: "Main",
          provider_type: "openai",
          base_url: "https://api.example.test/v1",
          deployment: "cloud" as const,
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
  };
}

async function authorityConfig() {
  tempHome = await mkdtemp(join(tmpdir(), "rainver-server-"));
  return loadConfig({
    SERVER_INTERNAL_TOKEN: "internal-token",
    RAINVER_HOME: tempHome,
  });
}

describe("providers and credentials server authority", () => {
  // Provider commands, the key pool and task chains run through the operation core on real
  // PostgreSQL: `settingsOperationsDb.test.ts`. This fake store only backs the transport check.
  it("does not expose decrypted keys over the internal HTTP resolve hatch", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setProviderCommandStoreForTests(fakeStore());
    app = buildModuleServer(await authorityConfig(), [providersModule]);

    const resolved = await app.inject({
      method: "POST",
      url: "/internal/providers-credentials/credentials/runtime/resolve",
      headers: {
        "content-type": "application/json",
        "x-rainver-internal-token": "internal-token",
      },
      payload: JSON.stringify({
        kind: "model_provider_api_key",
        space_id: "space-1",
        provider_id: "provider-1",
      }),
    });
    expect(resolved.statusCode).toBe(404);
    expect(JSON.stringify(resolved.json())).not.toContain("sk-test");
  });
});
