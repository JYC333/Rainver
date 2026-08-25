import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { getDbPool } from "../src/db/pool";
import { buildModuleServer } from "./support/moduleServer";
import { agentTemplatesModule } from "../src/modules/agentTemplates";
import { __setAgentChatIdentityForTests, agentsModule } from "../src/modules/agents";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { __setContentCreationContextResolverForTests } from "../src/modules/access/creationContext";

vi.mock("../src/db/pool", () => ({
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
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

describe("agents CRUD routes", () => {
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
              adapter_type: "capability",
              model_provider_id: null,
              provider_name: null,
              provider_type: null,
              model_name: null,
              credential_profile_id: null,
              runtime_config_json: { adapter_type: "capability" },
              runtime_policy_json: { default_adapter_type: "capability" },
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
                description: "Uses Model API",
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
                runtime_policy_json: { default_adapter_type: "capability" },
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
        description: "Uses Model API",
        system_prompt: "Act carefully.",
        adapter_type: "capability",
        default_model_provider_id: null,
        default_model: null,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: agentId,
      space_id: "space-1",
      created_by_user_id: "user-1",
      name: "API Agent",
      adapter_type: "capability",
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
        if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO agents")) {
          agentId = String(params[0]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO agent_versions")) {
          versionId = String(params[0]);
          insertedSystemPrompt = params[6] === null ? null : String(params[6]);
          insertedRuntimeConfig = JSON.parse(String(params[8])) as Record<string, unknown>;
          insertedContextPolicy = JSON.parse(String(params[9])) as Record<string, unknown>;
          insertedScheduleConfig = JSON.parse(String(params[16])) as Record<string, unknown>;
          insertedPromptProvenance = params[18]
            ? JSON.parse(String(params[18])) as Record<string, unknown>
            : null;
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
              adapter_type: "capability",
              model_provider_id: null,
              provider_name: null,
              provider_type: null,
              model_name: null,
              credential_profile_id: null,
              runtime_config_json: insertedRuntimeConfig,
              runtime_policy_json: { default_adapter_type: "capability" },
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
                runtime_policy_json: { default_adapter_type: "capability" },
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
        adapter_type: "capability",
        runtime_config_json: { adapter_type: "capability" },
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
      adapter_type: "capability",
    });
    expect(insertedRuntimeConfig).toMatchObject({ adapter_type: "capability" });
    expect(insertedContextPolicy).toMatchObject({ default_input_contexts: ["selected_workspace"] });
    expect(insertedScheduleConfig).toEqual({ enabled: false, cron: null });
    expect(insertedSystemPrompt).toBe("Registry reviewer prompt.");
    expect(insertedPromptProvenance).toMatchObject({
      asset_key: "agent_template.coding_reviewer.system",
      version_id: "prompt-version",
      content_hash: "prompt-hash",
    });
  });

  it("lists runtime profiles for an agent", async () => {
    const query = vi.fn(async (sql: string) => {
      const norm = sql.replace(/\s+/g, " ").trim();
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
            adapter_type: "model_api",
            model_provider_id: "provider-1",
            provider_name: "OpenAI",
            provider_type: "openai",
            model_name: "gpt-5-mini",
            credential_profile_id: null,
            runtime_config_json: { adapter_type: "model_api" },
            runtime_policy_json: { default_adapter_type: "model_api" },
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
        adapter_type: "model_api",
        model: expect.objectContaining({
          provider_id: "provider-1",
          provider_name: "OpenAI",
          model: "gpt-5-mini",
        }),
        enabled: true,
        is_default: true,
      }),
    ]);
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
        adapter_type: "claude_code",
        credential_profile_id: "credential-user-1",
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      detail: expect.stringContaining("selected per user and conversation"),
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
      model_provider_id: null,
      model_name: null,
      system_prompt: "Old prompt",
      model_config_json: {},
      runtime_config_json: { adapter_type: "capability" },
      context_policy_json: {},
      memory_policy_json: {},
      capabilities_json: [],
      tool_permissions_json: {},
      runtime_policy_json: { default_adapter_type: "capability" },
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
      description: "Uses Model API",
      role_instruction: null,
      status: "active",
      agent_kind: "standard",
      source_template_id: null,
      source_template_version_id: null,
      current_version_id: newVersionId || "agent-version-1",
      visibility: "private",
      created_at: "2026-06-17T00:00:00.000Z",
      updated_at: "2026-06-17T00:00:00.000Z",
      model_provider_id: null,
      provider_name: null,
      provider_type: null,
      model_name: null,
      system_prompt: "New prompt",
      runtime_policy_json: { default_adapter_type: "capability" },
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
});
