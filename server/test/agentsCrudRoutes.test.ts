import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { getDbPool } from "../src/db/pool.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { agentTemplatesModule } from "../src/modules/agentTemplates/index.js";
import { __setAgentChatIdentityForTests } from "../src/modules/agents/routes.js";
import { agentsModule } from "../src/modules/agents/index.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests } from "../src/modules/auth/identity.js";
import { __setContentCreationContextResolverForTests } from "../src/modules/access/creationContext.js";
import { AgentRuntimeProfileCreateBodySchema } from "@rainver/protocol";

vi.mock("../src/db/pool.js", () => ({
  getDbPool: vi.fn(),
}));
// Direct-chat workspace restore below: the host dispatch preparation and the
// Conversation execution context are the boundary the restore tests fake.
vi.mock("../src/modules/agentGroups/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/agentGroups/service.js")>()),
  prepareHostConversationDispatch: vi.fn(async () => ({
    host_thread: {
      id: "thread-1",
      execution_host_id: "host-1",
      workspace_location_id: null,
      vendor_session_id: null,
    },
    workspace: { kind: "managed" },
    project_folder_id: null,
    git_snapshot: {
      source: "unavailable", workspace_location_id: null, branch: null, commit_sha: null,
      dirty: null, execution_ready: false, observed_at: "2026-10-14T00:00:00.000Z",
    },
    dispatch_lock_id: "lock-1",
    host_resume_attempted: false,
    host_prompt_fresh: true,
  })),
}));
vi.mock("../src/modules/agentGroups/agentIdentityPrompt.js", () => ({
  renderAgentIdentityPrompt: vi.fn(async () => null),
}));
vi.mock("../src/modules/sessions/executionContextRepository.js", () => ({
  PgConversationExecutionContextRepository: class {
    async lockDraft() { return { state: "draft" }; }
    async initialize() {}
  },
}));

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
  __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
  __setContentCreationContextResolverForTests(async (_db, input) => ({
    spaceId: input.requestSpaceId,
    projectId: input.projectId ?? null,
    visibility: input.projectId ? "space_shared" : "private",
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  __setAgentChatIdentityForTests(null);
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
  __setContentCreationContextResolverForTests(null);
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

describe("agents CRUD routes", () => {
  it("rejects deployment aliases at Profile API boundaries", () => {
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({
      name: "Default",
      runtime_key: "opencode",
    }).success).toBe(true);
    // `.strict()` refuses every deployment alias. Do not keep a second list
    // of those names on a route.
    for (const retired of ["adapter_type", "default_adapter_type", "allowed_adapter_types", "credential_profile_id"]) {
      const parsed = AgentRuntimeProfileCreateBodySchema.safeParse({
        name: "Default",
        runtime_key: "opencode",
        [retired]: "opencode",
      });
      expect(parsed.success, retired).toBe(false);
    }
  });

  it("keeps each Profile option bag to the keys it authors", () => {
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({
      name: "Default",
      runtime_key: "opencode",
      runtime_policy_json: { tools: ["fs.read"] },
    }).success).toBe(false);
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({
      name: "Default",
      runtime_key: "opencode",
      runtime_config_json: { allow_permission_bypass: true },
    }).success).toBe(false);
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({
      name: "Default",
      runtime_key: "opencode",
      runtime_config_json: { tools: ["fs.read"] },
      runtime_policy_json: { allow_permission_bypass: true },
    }).success).toBe(true);
  });

  it("lists agents with the public response shape", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agents?status=active,disabled,inactive",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("lists runtime profiles for an agent", async () => {
    const query = vi.fn(async (sql: string) => {
      const norm = sql.replace(/\s+/g, " ").trim();
      if (norm.includes("SELECT agent_kind, project_id") && norm.includes("FROM agents")) {
        return { rows: [{ agent_kind: "standard", project_id: null }], rowCount: 1 };
      }
      if (norm.includes("FROM agents a")) {
        return { rows: [{ id: "agent-1", space_id: "space-1", project_id: null, owner_user_id: "user-1", name: "Agent", description: null, role_instruction: null, status: "active", agent_kind: "standard", current_version_id: null, visibility: "private", access_level: "private" }], rowCount: 1 };
      }
      if (norm.startsWith("SELECT id FROM agents WHERE space_id = $1 AND id = $2")) {
        return { rows: [{ id: "agent-1" }], rowCount: 1 };
      }
      if (norm.includes("FROM agent_runtime_profiles arp")) {
        return {
          rows: [{
            id: "runtime-profile-1",
            space_id: "space-1",
            agent_id: "agent-1",
            name: "Default",
            runtime_key: "opencode",
            backend_mode: "model_provider",
            model_provider_id: "provider-1",
            provider_name: "OpenAI",
            provider_type: "openai",
            model_name: "gpt-5-mini",
            runtime_config_json: {
              purpose: "test",
              nested: [{ vendorApiKey: "legacy-secret", keep: true }],
            },
            runtime_policy_json: {
              purpose: "test",
              nested: { credentialProfileId: "legacy-credential", keep: true },
            },
            enabled: true,
            is_default: true,
            created_at: "2026-06-20T00:00:00.000Z",
            updated_at: "2026-06-20T00:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agents/agent-1/runtime-profiles",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: "runtime-profile-1",
        agent_id: "agent-1",
        name: "Default",
        runtime_key: "opencode",
        model: expect.objectContaining({
          provider_id: "provider-1",
          provider_name: "OpenAI",
          model: "gpt-5-mini",
        }),
        runtime_config_json: {
          purpose: "test",
          nested: [{ keep: true }],
        },
        runtime_policy_json: {
          purpose: "test",
          nested: { keep: true },
        },
        provider_binding: {
          state: "bound",
          provider_id: "provider-1",
          model: "gpt-5-mini",
        },
        created_at: "2026-06-20T00:00:00.000Z",
        updated_at: "2026-06-20T00:00:00.000Z",
        enabled: true,
        is_default: true,
      }),
    ]);
  });

});
