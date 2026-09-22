import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { getDbPool } from "../src/db/pool.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { agentTemplatesModule } from "../src/modules/agentTemplates/index.js";
import { __setAgentChatIdentityForTests } from "../src/modules/agents/routes.js";
import { agentsModule } from "../src/modules/agents/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { __setContentCreationContextResolverForTests } from "../src/modules/access/creationContext.js";
import { AgentRuntimeProfileCreateBodySchema } from "@rainver/protocol";

vi.mock("../src/db/pool.js", () => ({
  getDbPool: vi.fn(),
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
  __setAgentChatIdentityForTests(null);
  __setAuthIdentityForTests(null);
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
  it("rejects the retired adapter_type alias at Profile API boundaries", () => {
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({
      name: "Default",
      runtime_key: "opencode",
    }).success).toBe(true);
    // `.strict()` is the single rule that retires every deployment alias; no
    // route keeps its own list of the retired names.
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

  it("rejects ModelProvider Profiles without an execution Host before changing the default", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "agent-1" }], rowCount: 1 }));
    const { PgAgentRepository } = await import("../src/modules/agents/repository.js");
    // The Profile write now validates inside the transaction that holds the
    // Agent row lock, so the fake pool has to be connectable.
    const repository = new PgAgentRepository({
      query,
      connect: async () => ({ query, release: () => {} }),
    } as never);

    await expect(repository.createRuntimeProfile("space-1", "agent-1", {
      name: "Provider profile",
      runtimeKey: "opencode",
      backendMode: "model_provider",
      modelProviderId: "provider-1",
      modelName: "test-model",
      isDefault: true,
    })).rejects.toThrow("ModelProvider-backed runtime profiles must name an execution Host");

    // requireAgent, then the transaction's own Agent lock; nothing writes.
    const statements = query.mock.calls
      .map((call) => String((call as unknown as unknown[])[0]).replace(/\s+/g, " ").trim());
    expect(statements).toEqual([
      "SELECT id FROM agents WHERE space_id = $1 AND id = $2 LIMIT 1",
      "BEGIN",
      "SELECT id FROM agents WHERE space_id = $1 AND id = $2 FOR UPDATE",
      "ROLLBACK",
    ]);
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

  it("creates an agent and returns its initial immutable version", async () => {
    let agentId = "";
    let versionId = "";
    let runtimeProfileId = "";
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        if (sql.includes("SELECT id FROM hosts WHERE kind = 'server'")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("JOIN hosts h ON h.machine_id = m.id")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO machines")) {
          return { rows: [{ id: "server-machine" }], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO hosts")) {
          return { rows: [{ id: "server-host" }], rowCount: 1 };
        }
        if (sql.includes("FROM hosts WHERE id = $1")) {
          return { rows: [{ host_owner_user_id: null, host_kind: "server", host_status: "offline", capabilities_json: {}, location_host_id: null, location_space_id: null, location_status: null, folder_space_id: null, folder_project_id: null }], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO agents")) {
          agentId = String(params[0]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO agent_versions")) {
          versionId = String(params[0]);
          return { rows: [{ id: versionId }], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO agent_runtime_profiles")) {
          runtimeProfileId = String(params[0]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM agent_runtime_profiles arp")) {
          return {
            rows: [{
              id: runtimeProfileId,
              space_id: "space-1",
              agent_id: agentId,
              name: "Default",
              runtime_key: "opencode",
              backend_mode: "runtime_native",
              model_provider_id: null,
              provider_name: null,
              provider_type: null,
              model_name: null,
              runtime_config_json: {},
              runtime_policy_json: {},
              enabled: true,
              is_default: true,
              created_at: "2026-06-17T00:00:00.000Z",
              updated_at: "2026-06-17T00:00:00.000Z",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM agents a")) {
          return {
            rows: [
              {
                id: agentId,
                space_id: "space-1",
                owner_user_id: "user-1",
                name: "API Agent",
                description: "Uses the default runtime profile",
                role_instruction: null,
                status: "active",
                agent_kind: "standard",
                source_template_id: null,
                source_template_version_id: null,
                current_version_id: versionId,
                visibility: "private",
                created_at: "2026-06-17T00:00:00.000Z",
                updated_at: "2026-06-17T00:00:00.000Z",
                model_provider_id: null,
                provider_name: null,
                provider_type: null,
                model_name: null,
                system_prompt: "Act carefully.",
                runtime_key: "opencode",
                runtime_policy_json: {},
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    };
    vi.mocked(getDbPool).mockReturnValue(pool as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: {
        name: "API Agent",
        description: "Uses the default runtime profile",
        system_prompt: "Act carefully.",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: agentId,
      space_id: "space-1",
      created_by_user_id: "user-1",
      name: "API Agent",
      runtime_key: "opencode",
      current_version_id: versionId,
    });
  });

  it("creates an agent from a template with the unified create payload", async () => {
    let agentId = "";
    let versionId = "";
    let runtimeProfileId = "";
    let insertedSystemPrompt: string | null = null;
    let insertedPromptProvenance: Record<string, unknown> | null = null;
    let insertedRuntimeConfig: Record<string, unknown> = {};
    let insertedContextPolicy: Record<string, unknown> = {};
    let insertedScheduleConfig: Record<string, unknown> = {};
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        if (sql.includes("SELECT id FROM hosts WHERE kind = 'server'")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("JOIN hosts h ON h.machine_id = m.id")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO machines")) {
          return { rows: [{ id: "server-machine" }], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO hosts")) {
          return { rows: [{ id: "server-host" }], rowCount: 1 };
        }
        if (sql.includes("FROM hosts WHERE id = $1")) {
          return { rows: [{ host_owner_user_id: null, host_kind: "server", host_status: "offline", capabilities_json: {}, location_host_id: null, location_space_id: null, location_status: null, folder_space_id: null, folder_project_id: null }], rowCount: 1 };
        }
        if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO agents")) {
          agentId = String(params[0]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO agent_versions")) {
          versionId = String(params[0]);
          insertedSystemPrompt = params[4] === null ? null : String(params[4]);
          insertedContextPolicy = JSON.parse(String(params[5])) as Record<string, unknown>;
          insertedScheduleConfig = JSON.parse(String(params[11])) as Record<string, unknown>;
          insertedPromptProvenance = params[13]
            ? JSON.parse(String(params[13])) as Record<string, unknown>
            : null;
          expect(params[14]).toBe("low");
          expect(params[15]).toBe(600);
          return { rows: [{ id: versionId }], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO agent_runtime_profiles")) {
          runtimeProfileId = String(params[0]);
          insertedRuntimeConfig = JSON.parse(String(params[12])) as Record<string, unknown>;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM agent_runtime_profiles arp")) {
          return {
            rows: [{
              id: runtimeProfileId,
              space_id: "space-1",
              agent_id: agentId,
              name: "Default",
              runtime_key: "opencode",
              backend_mode: "runtime_native",
              model_provider_id: null,
              provider_name: null,
              provider_type: null,
              model_name: null,
              runtime_config_json: insertedRuntimeConfig,
              runtime_policy_json: {},
              enabled: true,
              is_default: true,
              created_at: "2026-06-17T00:00:00.000Z",
              updated_at: "2026-06-17T00:00:00.000Z",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM agents a")) {
          return {
            rows: [
              {
                id: agentId,
                space_id: "space-1",
                owner_user_id: "user-1",
                name: "Reviewer",
                description: "Prefilled and edited",
                role_instruction: null,
                status: "active",
                agent_kind: "standard",
                current_version_id: versionId,
                visibility: "private",
                created_at: "2026-06-17T00:00:00.000Z",
                updated_at: "2026-06-17T00:00:00.000Z",
                model_provider_id: null,
                provider_name: null,
                provider_type: null,
                model_name: null,
                system_prompt: insertedSystemPrompt,
                runtime_key: "opencode",
                runtime_policy_json: {},
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM model_providers")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM evolvable_assets")) {
          return {
            rows: [{
              id: "prompt-asset",
              space_id: null,
              asset_type: "prompt_template",
              asset_key: "agent_template.coding_reviewer.system",
              display_name: "Coding Reviewer System Prompt",
              description: null,
              owner_scope_type: "system",
              owner_scope_id: null,
              status: "active",
              current_system_version_id: "prompt-version",
              default_eval_suite_ref_json: null,
              metadata_json: { prompt_type: "agent_system" },
              created_at: "2026-06-17T00:00:00.000Z",
              updated_at: "2026-06-17T00:00:00.000Z",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM prompt_deployment_refs")) {
          return { rows: [{ version_id: "prompt-version" }], rowCount: 1 };
        }
        if (sql.includes("FROM evolvable_asset_versions")) {
          return {
            rows: [{
              id: "prompt-version",
              space_id: null,
              scope_type: "system",
              scope_id: null,
              content_hash: "prompt-hash",
              status: "approved",
              content_json: {
                schema_version: "prompt_asset.v1",
                prompt_type: "agent_system",
                messages: [{ role: "system", content: "Registry reviewer prompt." }],
              },
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    vi.mocked(getDbPool).mockReturnValue(pool as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent-templates/coding_reviewer/agents",
      payload: {
        name: "Reviewer",
        description: "Prefilled and edited",
        context_policy_json: {
          allowed_input_contexts: ["selected_workspace"],
          default_input_contexts: ["selected_workspace"],
        },
        schedule_config_json: { enabled: false, cron: null },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: agentId,
      name: "Reviewer",
      runtime_key: "opencode",
    });
    expect(insertedRuntimeConfig).not.toHaveProperty("runtime_key");
    expect(insertedContextPolicy).toMatchObject({ default_input_contexts: ["selected_workspace"] });
    expect(insertedScheduleConfig).toEqual({ enabled: false, cron: null });
    expect(insertedSystemPrompt).toBe("Registry reviewer prompt.");
    expect(insertedPromptProvenance).toMatchObject({
      asset_key: "agent_template.coding_reviewer.system",
      version_id: "prompt-version",
      content_hash: "prompt-hash",
    });
  });

  it("rejects runtime selection on Agent creation", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    vi.mocked(getDbPool).mockReturnValue({
      connect: vi.fn(async () => client),
      query: vi.fn(),
    } as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { name: "Runtime selection", runtime_key: "opencode" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      detail: "runtime_key is Runtime Profile authority; configure it through the Runtime Profile API",
    });
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

  it("passes host binding fields through runtime profile creation", async () => {
    let inserted: readonly unknown[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO agent_runtime_profiles")) {
          inserted = params;
          return { rows: [], rowCount: 1 };
        }
        // The Profile write takes the Agent row's lock before it validates.
        if (norm.startsWith("SELECT id FROM agents")) {
          return { rows: [{ id: "agent-1" }], rowCount: 1 };
        }
        if (sql.includes("SELECT project_id, owner_user_id FROM agents")) {
          return { rows: [{ project_id: "project-1", owner_user_id: "user-1" }], rowCount: 1 };
        }
        if (sql.includes("SELECT host.owner_user_id AS host_owner_user_id")) {
          return {
            rows: [{
              host_owner_user_id: "user-1",
              host_kind: "remote",
              host_status: "online",
              capabilities_json: {
                installations: {
                  claude_code: [{ id: "own", version: "1.0.0", logged_in: true }],
                },
              },
              location_host_id: "host-1",
              location_space_id: "space-1",
              location_status: "active",
              folder_space_id: "space-1",
              folder_project_id: "project-1",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM agent_runtime_profiles arp")) {
          return {
            rows: [{
              id: "runtime-profile-1",
              space_id: "space-1",
              agent_id: "agent-1",
              name: "Host Reviewer",
              runtime_key: "claude_code",
              backend_mode: "runtime_native",
              execution_host_id: "host-1",
              workspace_location_id: "location-1",
              workspace_mode: "location",
              runtime_installation: "own",
              model_provider_id: null,
              provider_name: null,
              provider_type: null,
              model_name: null,
              runtime_config_json: { permission_mode: "approve" },
              runtime_policy_json: { workspace_isolation: "managed" },
              enabled: true,
              is_default: false,
              created_at: "2026-06-20T00:00:00.000Z",
              updated_at: "2026-06-20T00:00:00.000Z",
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
      const pool = {
        connect: vi.fn(async () => client),
        query: vi.fn(async (sql: string) => {
          const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.includes("SELECT agent_kind, project_id") && normalized.includes("FROM agents")) {
          return { rows: [{ agent_kind: "standard", project_id: null }], rowCount: 1 };
        }
        if (normalized.includes("FROM agents a")) {
          return { rows: [{ id: "agent-1", space_id: "space-1", project_id: null, owner_user_id: "user-1", name: "Agent", description: null, role_instruction: null, status: "active", agent_kind: "standard", current_version_id: null, visibility: "private", access_level: "private" }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT id FROM agents")) {
          return { rows: [{ id: "agent-1" }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT owner_user_id, agent_kind FROM agents")) {
          return { rows: [{ owner_user_id: "user-1", agent_kind: "standard" }], rowCount: 1 };
        }
        if (normalized.includes("FROM agents content_resource")) {
          return { rows: [{ one: 1 }], rowCount: 1 };
        }
        if (normalized.includes("SELECT project_id, owner_user_id FROM agents")) {
          return { rows: [{ project_id: "project-1", owner_user_id: "user-1" }], rowCount: 1 };
        }
        if (normalized.includes("SELECT host.owner_user_id AS host_owner_user_id")) {
          return {
            rows: [{
              host_owner_user_id: "user-1",
              host_kind: "remote",
              host_status: "online",
              capabilities_json: {
                installations: {
                  claude_code: [{ id: "own", version: "1.0.0", logged_in: true }],
                },
              },
              location_host_id: "host-1",
              location_space_id: "space-1",
              location_status: "active",
              folder_space_id: "space-1",
              folder_project_id: "project-1",
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    vi.mocked(getDbPool).mockReturnValue(pool as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/runtime-profiles",
      payload: {
        name: "Host Reviewer",
        runtime_key: "claude_code",
        execution_host_id: "host-1",
        workspace_location_id: "location-1",
        workspace_mode: "location",
        runtime_installation: "own",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      execution_host_id: "host-1",
      workspace_location_id: "location-1",
      runtime_installation: "own",
    });
    expect(inserted[8]).toBe("host-1");
    expect(inserted[9]).toBe("location-1");
    expect(inserted[10]).toBe("location");
    expect(inserted[11]).toBe("own");
  });

  it("leaves unnamed Profile fields alone when a PATCH only flips the default", async () => {
    // The product default is a host-bound `runtime_native` Profile. A partial
    // PATCH that names only `is_default` must not clear its execution target
    // (B46) or its enabled state: an unbound Profile is dropped from routing
    // and the Agent never gets a candidate again.
    const profileRow: Record<string, unknown> = {
      id: "runtime-profile-1",
      space_id: "space-1",
      agent_id: "agent-1",
      name: "Server Runtime",
      runtime_key: "claude_code",
      backend_mode: "runtime_native",
      execution_host_id: "host-1",
      workspace_location_id: "location-1",
      workspace_mode: "location",
      runtime_installation: "own",
      model_provider_id: null,
      provider_name: null,
      provider_type: null,
      model_name: null,
      runtime_config_json: { permission_mode: "approve" },
      runtime_policy_json: { allow_permission_bypass: true },
      enabled: true,
      is_default: false,
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:00:00.000Z",
    };
    const hostRow = {
      host_owner_user_id: "user-1",
      host_kind: "remote",
      host_status: "online",
      capabilities_json: {
        installations: {
          claude_code: [{ id: "own", version: "1.0.0", logged_in: true }],
        },
      },
      location_host_id: "host-1",
      location_space_id: "space-1",
      location_status: "active",
      folder_space_id: "space-1",
      folder_project_id: "project-1",
    };
    let updated: readonly unknown[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (norm.startsWith("UPDATE agent_runtime_profiles SET name = $4")) {
          updated = params;
          Object.assign(profileRow, {
            name: params[3],
            runtime_key: params[4],
            backend_mode: params[5],
            model_provider_id: params[6],
            model_name: params[7],
            execution_host_id: params[8],
            workspace_location_id: params[9],
            workspace_mode: params[10],
            runtime_installation: params[11],
            runtime_config_json: JSON.parse(String(params[12])),
            runtime_policy_json: JSON.parse(String(params[13])),
            enabled: params[14],
            is_default: params[15],
          });
          return { rows: [{ id: "runtime-profile-1" }], rowCount: 1 };
        }
        if (norm.startsWith("UPDATE agent_runtime_profiles SET is_default = false")) {
          return { rows: [], rowCount: 0 };
        }
        if (norm.startsWith("SELECT id FROM agents")) {
          return { rows: [{ id: "agent-1" }], rowCount: 1 };
        }
        if (norm.includes("SELECT project_id, owner_user_id FROM agents")) {
          return { rows: [{ project_id: "project-1", owner_user_id: "user-1" }], rowCount: 1 };
        }
        if (norm.includes("SELECT host.owner_user_id AS host_owner_user_id")) {
          return { rows: [hostRow], rowCount: 1 };
        }
        if (norm.includes("FROM agent_runtime_profiles arp")) {
          return { rows: [{ ...profileRow }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.includes("SELECT agent_kind, project_id") && normalized.includes("FROM agents")) {
          return { rows: [{ agent_kind: "standard", project_id: "project-1" }], rowCount: 1 };
        }
        if (normalized.includes("FROM agents content_resource")) {
          return { rows: [{ one: 1 }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT owner_user_id, agent_kind FROM agents")) {
          return { rows: [{ owner_user_id: "user-1", agent_kind: "standard" }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT id FROM agents")) {
          return { rows: [{ id: "agent-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    vi.mocked(getDbPool).mockReturnValue(pool as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agent-1/runtime-profiles/runtime-profile-1",
      payload: { is_default: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      execution_host_id: "host-1",
      workspace_location_id: "location-1",
      workspace_mode: "location",
      runtime_installation: "own",
      runtime_key: "claude_code",
      backend_mode: "runtime_native",
      name: "Server Runtime",
      enabled: true,
      is_default: true,
    });
    expect(updated[3]).toBe("Server Runtime");
    expect(updated[4]).toBe("claude_code");
    expect(updated[8]).toBe("host-1");
    expect(updated[9]).toBe("location-1");
    expect(updated[10]).toBe("location");
    expect(updated[11]).toBe("own");
    expect(JSON.parse(String(updated[12]))).toEqual({ permission_mode: "approve" });
    expect(JSON.parse(String(updated[13]))).toEqual({ allow_permission_bypass: true });
    expect(updated[14]).toBe(true);
    expect(updated[15]).toBe(true);
  });

  it("refuses a PATCH that switches a native Profile to model_provider without a Provider and model", async () => {
    // The merge is what makes this reachable from a one-field PATCH: the body
    // names only the mode, and the Profile it is applied to has no binding to
    // supply. Admission sees the merged shape, so the route answers 422
    // instead of storing a `model_provider` Profile with nothing to call.
    const profileRow: Record<string, unknown> = {
      id: "runtime-profile-1",
      space_id: "space-1",
      agent_id: "agent-1",
      name: "Server Runtime",
      // `opencode` is the runtime whose contract supports both backend modes,
      // so the refusal here is the missing binding rather than the mode being
      // unavailable on this runtime at all.
      runtime_key: "opencode",
      backend_mode: "runtime_native",
      execution_host_id: "host-1",
      workspace_location_id: "location-1",
      workspace_mode: "location",
      runtime_installation: "own",
      model_provider_id: null,
      provider_name: null,
      provider_type: null,
      model_name: null,
      runtime_config_json: {},
      runtime_policy_json: {},
      enabled: true,
      is_default: true,
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:00:00.000Z",
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (norm.startsWith("UPDATE agent_runtime_profiles")) {
          throw new Error("admission must refuse before any Profile write");
        }
        if (norm.startsWith("SELECT id FROM agents")) {
          return { rows: [{ id: "agent-1" }], rowCount: 1 };
        }
        if (norm.includes("SELECT project_id, owner_user_id FROM agents")) {
          return { rows: [{ project_id: "project-1", owner_user_id: "user-1" }], rowCount: 1 };
        }
        if (norm.includes("FROM agent_runtime_profiles arp")) {
          return { rows: [{ ...profileRow }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.includes("SELECT agent_kind, project_id") && normalized.includes("FROM agents")) {
          return { rows: [{ agent_kind: "standard", project_id: "project-1" }], rowCount: 1 };
        }
        if (normalized.includes("FROM agents content_resource")) {
          return { rows: [{ one: 1 }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT owner_user_id, agent_kind FROM agents")) {
          return { rows: [{ owner_user_id: "user-1", agent_kind: "standard" }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT id FROM agents")) {
          return { rows: [{ id: "agent-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    vi.mocked(getDbPool).mockReturnValue(pool as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agent-1/runtime-profiles/runtime-profile-1",
      payload: { backend_mode: "model_provider" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      detail: "model_provider profiles require a same-Space ModelProvider and explicit model",
    });
  });

  it("clears a Profile field only when the PATCH names it as null", async () => {
    // The `.nullish()` protocol body is what tells "unnamed" from "explicitly
    // cleared"; only the latter may drop a ModelProvider binding.
    const profileRow: Record<string, unknown> = {
      id: "runtime-profile-1",
      space_id: "space-1",
      agent_id: "agent-1",
      name: "Provider Profile",
      runtime_key: "claude_code",
      backend_mode: "model_provider",
      execution_host_id: "host-1",
      workspace_location_id: "location-1",
      workspace_mode: "location",
      runtime_installation: "own",
      model_provider_id: "provider-1",
      provider_name: "OpenAI",
      provider_type: "openai",
      model_name: "gpt-5-mini",
      runtime_config_json: {},
      runtime_policy_json: {},
      enabled: true,
      is_default: false,
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:00:00.000Z",
    };
    let updated: readonly unknown[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (norm.startsWith("UPDATE agent_runtime_profiles SET name = $4")) {
          updated = params;
          Object.assign(profileRow, {
            backend_mode: params[5],
            model_provider_id: params[6],
            provider_name: params[6] === null ? null : profileRow.provider_name,
            provider_type: params[6] === null ? null : profileRow.provider_type,
            model_name: params[7],
          });
          return { rows: [{ id: "runtime-profile-1" }], rowCount: 1 };
        }
        if (norm.startsWith("SELECT id FROM agents")) {
          return { rows: [{ id: "agent-1" }], rowCount: 1 };
        }
        if (norm.includes("SELECT project_id, owner_user_id FROM agents")) {
          return { rows: [{ project_id: "project-1", owner_user_id: "user-1" }], rowCount: 1 };
        }
        if (norm.includes("SELECT host.owner_user_id AS host_owner_user_id")) {
          return {
            rows: [{
              host_owner_user_id: "user-1",
              host_kind: "remote",
              host_status: "online",
              capabilities_json: {
                installations: { claude_code: [{ id: "own", version: "1.0.0", logged_in: true }] },
              },
              location_host_id: "host-1",
              location_space_id: "space-1",
              location_status: "active",
              folder_space_id: "space-1",
              folder_project_id: "project-1",
            }],
            rowCount: 1,
          };
        }
        if (norm.includes("FROM agent_runtime_profiles arp")) {
          return { rows: [{ ...profileRow }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.includes("SELECT agent_kind, project_id") && normalized.includes("FROM agents")) {
          return { rows: [{ agent_kind: "standard", project_id: "project-1" }], rowCount: 1 };
        }
        if (normalized.includes("FROM agents content_resource")) {
          return { rows: [{ one: 1 }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT owner_user_id, agent_kind FROM agents")) {
          return { rows: [{ owner_user_id: "user-1", agent_kind: "standard" }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT id FROM agents")) {
          return { rows: [{ id: "agent-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    vi.mocked(getDbPool).mockReturnValue(pool as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/agent-1/runtime-profiles/runtime-profile-1",
      payload: {
        backend_mode: "runtime_native",
        model_provider_id: null,
        model_name: null,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updated[5]).toBe("runtime_native");
    expect(updated[6]).toBeNull();
    expect(updated[7]).toBeNull();
    expect(res.json()).toMatchObject({
      backend_mode: "runtime_native",
      execution_host_id: "host-1",
      provider_binding: { state: "unbound", provider_id: null, model: null },
    });
  });

  it("rejects user credentials on shared Agent runtime profiles", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/runtime-profiles",
      payload: {
        name: "Unsafe shared login",
        runtime_key: "claude_code",
        credential_profile_id: "credential-user-1",
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      detail: expect.stringContaining("brokers no CLI credential"),
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects credentials nested in Agent runtime profile config before repository access", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/runtime-profiles",
      payload: {
        name: "Nested credential",
        runtime_key: "claude_code",
        runtime_config_json: { vendor: { auth: [{ credentialProfileId: "credential-user-1" }] } },
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      detail: expect.stringContaining("credentialProfileId"),
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("does not touch the Space policy digest when Agent config changes", async () => {
    let newVersionId = "";
    const jobs: Array<{ agent_id: unknown; payload: Record<string, unknown> }> = [];
    const currentVersion = {
      id: "agent-version-1",
      agent_id: "agent-1",
      space_id: "space-1",
      version_label: "v1",
      system_prompt: "Old prompt",
      context_policy_json: {},
      memory_policy_json: {},
      capabilities_json: [],
      tool_permissions_json: {},
      tool_policy_json: {},
      output_policy_json: {},
      schedule_config_json: {},
      output_schema_json: {},
      source_proposal_id: null,
      source_activity_id: null,
      created_at: "2026-06-17T00:00:00.000Z",
      published_at: null,
      archived_at: null,
    };
    const agentRow = () => ({
      id: "agent-1",
      space_id: "space-1",
      owner_user_id: "user-1",
      name: "API Agent",
      description: "Uses the default Server Runtime",
      role_instruction: null,
      status: "active",
      agent_kind: "standard",
      source_template_id: null,
      source_template_version_id: null,
      current_version_id: newVersionId || "agent-version-1",
      visibility: "private",
      effective_access_level: "full",
      created_at: "2026-06-17T00:00:00.000Z",
      updated_at: "2026-06-17T00:00:00.000Z",
      model_provider_id: null,
      provider_name: null,
      provider_type: null,
      model_name: null,
      system_prompt: "New prompt",
    });
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (norm.startsWith("SELECT version_label FROM agent_versions")) {
          return { rows: [{ version_label: "v1" }], rowCount: 1 };
        }
        if (norm.startsWith("SELECT current_version_id FROM agents")) {
          return { rows: [{ current_version_id: "agent-version-1" }], rowCount: 1 };
        }
        if (norm.includes("FROM agent_versions") && norm.includes("WHERE id = $1")) {
          return { rows: [currentVersion], rowCount: 1 };
        }
        if (norm.startsWith("INSERT INTO agent_versions")) {
          newVersionId = String(params[0]);
          return { rows: [{ id: newVersionId }], rowCount: 1 };
        }
        if (norm.startsWith("UPDATE agents SET current_version_id")) {
          return { rows: [], rowCount: 1 };
        }
        if (norm.startsWith("INSERT INTO jobs")) {
          jobs.push({
            agent_id: params[4],
            payload: JSON.parse(String(params[7])) as Record<string, unknown>,
          });
          return {
            rows: [{
              id: params[0],
              space_id: params[1],
              user_id: params[2],
              project_folder_id: params[3],
              agent_id: params[4],
              job_type: params[5],
              status: "pending",
              priority: params[6],
              payload_json: JSON.parse(String(params[7])),
              result_json: null,
              error: null,
              attempts: 0,
              max_attempts: params[8],
              scheduled_at: params[9],
              claimed_by: null,
              claimed_at: null,
              started_at: null,
              completed_at: null,
              heartbeat_at: null,
              created_at: params[10],
              updated_at: params[10],
            }],
            rowCount: 1,
          };
        }
        if (norm.includes("FROM agents a") && norm.includes("LEFT JOIN agent_versions")) {
          return { rows: [agentRow()], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
      const norm = sql.replace(/\s+/g, " ").trim();
        if (norm.startsWith("SELECT id FROM agents WHERE space_id = $1 AND id = $2")) {
          return { rows: [{ id: "agent-1" }], rowCount: 1 };
        }
        if (norm.startsWith("SELECT owner_user_id, agent_kind FROM agents")) {
          return { rows: [{ owner_user_id: "user-1", agent_kind: "standard" }], rowCount: 1 };
        }
        if (norm.includes("FROM agents content_resource")) {
          return { rows: [{ one: 1 }], rowCount: 1 };
        }
        if (norm.includes("FROM agents a") && norm.includes("JOIN agent_versions av")) {
          return { rows: [currentVersion], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    vi.mocked(getDbPool).mockReturnValue(pool as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/config",
      payload: { system_prompt: "New prompt" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: "agent-1",
      current_version_id: newVersionId,
      system_prompt: "New prompt",
    });
    // Agent config reaches a Run through its immutable AgentVersion. The only
    // Agent config reaches a Run through its immutable AgentVersion, so no
    // retired derived-context refresh side effect is expected.
    expect(jobs).toEqual([]);
  });

  it("refuses a person-started agent run that names its own origin or a system run type", async () => {
    const { PgAgentRepository } = await import("../src/modules/agents/repository.js");
    const { PgRunRepository } = await import("../src/modules/runs/repository.js");
    vi.mocked(getDbPool).mockReturnValue({
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as never);
    const visible = vi.spyOn(PgAgentRepository.prototype, "getVisible").mockResolvedValue({
      id: "agent-1",
    } as never);
    const created = vi.spyOn(PgRunRepository.prototype, "createQueuedRunWithBudgetAdmission").mockResolvedValue({
      id: "run-1",
      space_id: "space-1",
      agent_id: "agent-1",
      agent_version_id: "agent-version-1",
      status: "queued",
      mode: "live",
      prompt: "hi",
      instruction: null,
      project_folder_id: null,
      session_id: null,
      project_id: null,
      runtime_key: null,
      model_provider_id: null,
      required_sandbox_level: "none",
      trigger_origin: "manual",
      started_at: null,
      ended_at: null,
    } as never);
    app = buildModuleServer(config(), [agentsModule, agentTemplatesModule]);

    try {
      const labelled = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agent-1/runs",
        payload: { prompt: "hi", trigger_origin: "automation" },
      });
      expect(labelled.statusCode).toBe(422);
      const system = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agent-1/runs",
        payload: { prompt: "hi", run_type: "system" },
      });
      expect(system.statusCode).toBe(422);
      expect(created).not.toHaveBeenCalled();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agents/agent-1/runs",
        payload: { prompt: "hi" },
      });
      expect(res.statusCode).toBe(201);
      expect(created.mock.calls[0]?.[0]).toMatchObject({ trigger_origin: "manual" });
      expect(res.json().trigger_origin).toBe("manual");
    } finally {
      visible.mockRestore();
      created.mockRestore();
    }
  });
});
