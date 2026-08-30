import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { runsModule } from "../src/modules/runs/index.js";
import { agentsModule } from "../src/modules/agents/index.js";
import { loadConfig } from "../src/config.js";
import { __setAgentChatIdentityForTests, __setAgentChatServicesFactoryForTests } from "../src/modules/agents/routes.js";
import { __setContentCreationContextResolverForTests } from "../src/modules/access/creationContext.js";

let app: FastifyInstance;

beforeEach(() => {
  __setContentCreationContextResolverForTests(async (_db, input) => ({
    spaceId: input.requestSpaceId,
    projectId: input.projectId ?? null,
    visibility: input.projectId ? "space_shared" : "private",
  }));
});

type AgentChatServicesFactory = NonNullable<
  Parameters<typeof __setAgentChatServicesFactoryForTests>[0]
>;
type AgentChatServices = ReturnType<AgentChatServicesFactory>;
type AgentChatServiceOverrides = {
  [K in Exclude<keyof AgentChatServices, "inTransaction">]?:
    Partial<AgentChatServices[K]>;
} & {
  inTransaction?: AgentChatServices["inTransaction"];
};

afterEach(async () => {
  __setAgentChatIdentityForTests(null);
  __setAgentChatServicesFactoryForTests(null);
  __setContentCreationContextResolverForTests(null);
  await app?.close();
});

function chatConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

function services(overrides: AgentChatServiceOverrides = {}): AgentChatServices {
  const base: Omit<AgentChatServices, "inTransaction"> = {
    agents: {
      async getAgentForChat() {
        return {
          id: "agent-1",
          space_id: "space-1",
          name: "Assistant",
          current_version_id: "agent-version-1",
          tool_permissions_json: {},
        };
      },
    },
    sessions: {
      async getSession() {
        throw new Error("getSession should not run");
      },
      async createSession(
        _spaceId: string,
        _userId: string,
        input: { title?: string | null; projectId?: string | null },
      ) {
        return {
          id: "session-1",
          space_id: "space-1",
          user_id: "user-1",
          project_folder_id: null,
          project_id: input.projectId ?? null,
          title: input.title ?? null,
          status: "active",
          created_at: "2026-06-14T10:00:00.000Z",
          updated_at: "2026-06-14T10:00:00.000Z",
        };
      },
      async addMessage(_spaceId, _userId, sessionId, input) {
        return {
          id: "message-user-1",
          session_id: sessionId,
          space_id: "space-1",
          user_id: "user-1",
          role: input.role,
          content: input.content,
          metadata_json: input.metadata ?? null,
          created_at: "2026-06-14T10:00:00.000Z",
        };
      },
      async attachRunToUserMessage() {
        return true;
      },
    },
    backends: {
      async resolveBinding() {
        return {
          runtime_profile_id: "runtime-profile-1",
          adapter_type: "model_api",
          execution_host_id: null,
          workspace_location_id: null,
          runtime_installation: null,
          credential_profile_id: null,
          binding_id: "binding-1",
          runtime_state_key: "11111111-1111-4111-8111-111111111111",
          runtime_session_id: null,
          runtime_context_fingerprint: null,
          model_name: null,
          model_provider_id: null,
          runtime_config_json: {},
          runtime_policy_json: {},
          retired_runtime_state_key: null,
        };
      },
    },
    runtimeSessions: {
      async claimTurn() {},
      async prepare(input) {
        return {
          binding_id: input.binding_id,
          runtime_state_key: "11111111-1111-4111-8111-111111111111",
          runtime_session_id: null,
          runtime_context_fingerprint: null,
          retired_runtime_state_key: null,
        };
      },
    },
    runs: {
      async createQueuedRun(input) {
        return {
          id: "run-1",
          space_id: "space-1",
          agent_id: input.agent_id,
          agent_version_id: "agent-version-1",
          status: "queued",
          mode: input.mode,
          prompt: input.prompt ?? null,
          instruction: null,
          project_folder_id: null,
          session_id: input.session_id ?? null,
          project_id: null,
          adapter_type: null,
          model_provider_id: null,
          required_sandbox_level: "none",
          trigger_origin: input.trigger_origin,
          started_at: null,
          ended_at: null,
        };
      },
    },
    jobs: {
      async enqueue() {},
    },
  };
  const merged = {
    agents: { ...base.agents, ...overrides.agents },
    sessions: { ...base.sessions, ...overrides.sessions },
    backends: { ...base.backends, ...overrides.backends },
    runtimeSessions: { ...base.runtimeSessions, ...overrides.runtimeSessions },
    runs: { ...base.runs, ...overrides.runs },
    jobs: { ...base.jobs, ...overrides.jobs },
  };
  const result: AgentChatServices = {
    ...merged,
    inTransaction: overrides.inTransaction ??
      (async (work) => work(result)),
  };
  return result;
}

describe("agents asynchronous chat-turn route", () => {
  it("applies the instructing user's Agent visibility before creating a turn", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-2" });
    const lookups: string[][] = [];
    let transactionStarted = false;
    __setAgentChatServicesFactoryForTests(() =>
      services({
        agents: {
          async getAgentForChat(spaceId, userId, agentId) {
            lookups.push([spaceId, userId, agentId]);
            return null;
          },
        },
        async inTransaction() {
          transactionStarted = true;
          throw new Error("transaction should not start");
        },
      }),
    );
    app = buildModuleServer(chatConfig(), [agentsModule, runsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/private-agent/chat",
      payload: { message: "Use another member's private Agent" },
    });

    expect(response.statusCode).toBe(404);
    expect(lookups).toEqual([["space-1", "user-2", "private-agent"]]);
    expect(transactionStarted).toBe(false);
  });

  it("persists the user message, queues the Run, and returns immediately", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const messages: Array<Record<string, unknown>> = [];
    const runLinks: Array<Record<string, unknown>> = [];
    const jobs: Array<Record<string, unknown>> = [];
    __setAgentChatServicesFactoryForTests(() =>
      services({
        sessions: {
          async addMessage(_spaceId, _userId, sessionId, input) {
            messages.push({ sessionId, ...input });
            return {
              id: "message-user-1",
              session_id: sessionId,
              space_id: "space-1",
              user_id: "user-1",
              role: input.role,
              content: input.content,
              metadata_json: input.metadata ?? null,
              created_at: "2026-06-14T10:00:00.000Z",
            };
          },
          async attachRunToUserMessage(input) {
            runLinks.push(input);
            return true;
          },
        },
        jobs: {
          async enqueue(input) {
            jobs.push(input);
          },
        },
      }),
    );
    app = buildModuleServer(chatConfig(), [agentsModule, runsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "  Hi there  " },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      schema_version: "chat_turn_accepted.v1",
      session_id: "session-1",
      run_id: "run-1",
      user_message_id: "message-user-1",
      status: "queued",
      event_stream_url: "/api/v1/runs/run-1/events/stream",
      backend: {
        runtime_profile_id: "runtime-profile-1",
        adapter_type: "model_api",
        credential_profile_id: null,
      },
    });
    expect(messages).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        role: "user",
        content: "Hi there",
      }),
    ]);
    expect(jobs).toEqual([{
      run_id: "run-1",
      space_id: "space-1",
      user_id: "user-1",
      agent_id: "agent-1",
    }]);
    expect(runLinks).toEqual([{
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      message_id: "message-user-1",
      run_id: "run-1",
    }]);
  });

  it("rejects a Host-bound Agent outside an owner-authorized Room", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setAgentChatServicesFactoryForTests(() => services({
      backends: {
        async resolveBinding() {
          return {
            runtime_profile_id: "runtime-profile-1",
            adapter_type: "claude_code",
            credential_profile_id: null,
            binding_id: "binding-1",
            runtime_state_key: "11111111-1111-4111-8111-111111111111",
            runtime_session_id: null,
            runtime_context_fingerprint: null,
            model_name: null,
            model_provider_id: null,
            runtime_config_json: {},
            runtime_policy_json: {},
            execution_host_id: "host-1",
            workspace_location_id: "location-1",
            runtime_installation: "own",
            retired_runtime_state_key: null,
          };
        },
      },
    }));
    app = buildModuleServer(chatConfig(), [agentsModule, runsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "Run remotely" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      detail: "Host-bound Agents can only be addressed from an owner-authorized Room",
    });
  });

  it("rolls back the durable turn when job enqueue fails", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const transactionEvents: string[] = [];
    const configured = services({
      jobs: {
        async enqueue() {
          throw new Error("queue unavailable");
        },
      },
    });
    configured.inTransaction = async (work) => {
      transactionEvents.push("begin");
      try {
        return await work(configured);
      } catch (error) {
        transactionEvents.push("rollback");
        throw error;
      }
    };
    __setAgentChatServicesFactoryForTests(() => configured);
    app = buildModuleServer(chatConfig(), [agentsModule, runsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "Hi" },
    });

    expect(response.statusCode).toBe(503);
    expect(transactionEvents).toEqual(["begin", "rollback"]);
  });

  it("404s an invisible existing session before writing a user message", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let wrote = false;
    __setAgentChatServicesFactoryForTests(() =>
      services({
        sessions: {
          async getSession() {
            return null;
          },
          async createSession() {
            throw new Error("createSession should not run");
          },
          async addMessage() {
            wrote = true;
            throw new Error("addMessage should not run");
          },
        },
      }),
    );
    app = buildModuleServer(chatConfig(), [agentsModule, runsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "Hello?", session_id: "missing-session" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      detail: "session not found in this space",
    });
    expect(wrote).toBe(false);
  });

  it("rejects empty messages before creating durable work", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setAgentChatServicesFactoryForTests(() => services());
    app = buildModuleServer(chatConfig(), [agentsModule, runsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "   " },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      detail: "message must not be empty",
    });
  });

  it("persists only canonical turn and routing metadata before enqueue", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const observed: {
      queuedRun?: Record<string, unknown>;
      jobSawRun?: boolean;
    } = {};
    __setAgentChatServicesFactoryForTests(() =>
      services({
        backends: {
          async resolveBinding() {
            return {
              runtime_profile_id: "runtime-profile-1",
              adapter_type: "claude_code",
              execution_host_id: null,
              workspace_location_id: null,
              runtime_installation: null,
              credential_profile_id: "credential-1",
              binding_id: "binding-1",
              runtime_state_key: "11111111-1111-4111-8111-111111111111",
              runtime_session_id: null,
              runtime_context_fingerprint: null,
              model_name: "claude-opus-5",
              model_provider_id: null,
              runtime_config_json: {},
              runtime_policy_json: {},
              retired_runtime_state_key: null,
            };
          },
        },
        runs: {
          async createQueuedRun(input) {
            observed.queuedRun = input as unknown as Record<string, unknown>;
            return {
              ...(await services().runs.createQueuedRun(input)),
            };
          },
        },
        jobs: {
          async enqueue() {
            observed.jobSawRun = Boolean(observed.queuedRun);
          },
        },
      }),
    );
    app = buildModuleServer(chatConfig(), [agentsModule, runsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "Hi" },
    });

    expect(response.statusCode).toBe(202);
    expect(observed.queuedRun?.prompt).toBe("Hi");
    expect(observed.queuedRun?.model_override_json).toMatchObject({
      conversation_backend: {
        schema_version: "conversation_backend.v1",
        runtime_profile_id: "runtime-profile-1",
        adapter_type: "claude_code",
        credential_profile_id: "credential-1",
      },
      execution_mode: "conversation_lightweight.v1",
      chat_turn: {
        schema_version: "chat_turn.v1",
        session_id: "session-1",
        user_id: "user-1",
        user_message_id: "message-user-1",
        agent_id: "agent-1",
        agent_version_id: "agent-version-1",
        project_id: null,
      },
    });
    expect(observed.queuedRun?.model_override_json).not.toHaveProperty("messages");
    expect(observed.queuedRun?.model_override_json).not.toHaveProperty("conversation_runtime");
    expect(observed.queuedRun?.model_override_json).not.toHaveProperty("chat_context_preamble");
    expect(observed.queuedRun?.model_override_json).not.toHaveProperty("conversation_window_version");
    expect(observed.jobSawRun).toBe(true);
  });

  it("queues only the canonical increment and defers CLI session selection to orchestration", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let queuedRun: Record<string, unknown> | undefined;
    __setAgentChatServicesFactoryForTests(() =>
      services({
        backends: {
          async resolveBinding() {
            return {
              runtime_profile_id: "runtime-profile-1",
              adapter_type: "opencode",
              execution_host_id: null,
              workspace_location_id: null,
              runtime_installation: null,
              credential_profile_id: "credential-1",
              binding_id: "binding-1",
              runtime_state_key: "11111111-1111-4111-8111-111111111111",
              runtime_session_id: "ses_existing-opaque",
              runtime_context_fingerprint: "old-fingerprint",
              model_name: "provider/model",
              model_provider_id: "provider-1",
              runtime_config_json: {},
              runtime_policy_json: {},
              retired_runtime_state_key: null,
            };
          },
        },
        runtimeSessions: {
          async prepare(input) {
            return {
              binding_id: input.binding_id,
              runtime_state_key: "11111111-1111-4111-8111-111111111111",
              runtime_session_id: "ses_existing-opaque",
              runtime_context_fingerprint: input.context_fingerprint,
              retired_runtime_state_key: null,
            };
          },
        },
        runs: {
          async createQueuedRun(input) {
            queuedRun = input as unknown as Record<string, unknown>;
            return services().runs.createQueuedRun(input);
          },
        },
      }),
    );
    app = buildModuleServer(chatConfig(), [agentsModule, runsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "NEW TURN" },
    });

    expect(response.statusCode).toBe(202);
    expect(queuedRun?.prompt).toContain("NEW TURN");
    expect(queuedRun?.prompt).not.toContain("OLD HISTORY");
    expect(queuedRun?.model_override_json).not.toHaveProperty("conversation_runtime");
  });

  it("does not author runtime fingerprints in the HTTP route", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let runtimeRevision = 1;
    const fingerprints: string[] = [];
    __setAgentChatServicesFactoryForTests(() =>
      services({
        backends: {
          async resolveBinding() {
            return {
              runtime_profile_id: "runtime-profile-1",
              adapter_type: "claude_code",
              execution_host_id: null,
              workspace_location_id: null,
              runtime_installation: null,
              credential_profile_id: "credential-1",
              binding_id: "binding-1",
              runtime_state_key: "11111111-1111-4111-8111-111111111111",
              runtime_session_id: "22222222-2222-4222-8222-222222222222",
              runtime_context_fingerprint: "old",
              model_name: "claude",
              model_provider_id: null,
              runtime_config_json: { revision: runtimeRevision },
              runtime_policy_json: { allow_permission_bypass: false },
              retired_runtime_state_key: null,
            };
          },
        },
        runtimeSessions: {
          async prepare(input) {
            fingerprints.push(input.context_fingerprint);
            return {
              binding_id: input.binding_id,
              runtime_state_key: input.runtime_state_key,
              runtime_session_id: null,
              runtime_context_fingerprint: null,
              retired_runtime_state_key: null,
            };
          },
        },
      }),
    );
    app = buildModuleServer(chatConfig(), [agentsModule, runsModule]);

    await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "first" },
    });
    runtimeRevision = 2;
    await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "second" },
    });

    expect(fingerprints).toEqual([]);
  });
});
