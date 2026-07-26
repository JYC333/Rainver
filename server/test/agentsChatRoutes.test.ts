import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import {
  __setAgentChatIdentityForTests,
  __setAgentChatServicesFactoryForTests,
} from "../src/modules/agents";

let app: FastifyInstance;

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
  await app?.close();
});

function chatConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
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
      async listRecentMessagesForContext() {
        return [];
      },
      async getLatestSummaryForContext() {
        return null;
      },
    },
    backends: {
      async resolveBinding() {
        return {
          runtime_profile_id: "runtime-profile-1",
          adapter_type: "model_api",
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
    context: {
      async fetchCandidates() {
        return {
          allowed_sources: [],
          max_tokens: 4000,
          max_items: 20,
          context_policy_applied: true,
          items: [],
        };
      },
    },
    snapshots: {
      async persistChatSnapshot() {},
    },
    runs: {
      async createQueuedRun(input) {
        return {
          id: "run-1",
          space_id: "space-1",
          agent_id: input.agent_id,
          agent_version_id: "agent-version-1",
          context_snapshot_id: null,
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
    context: { ...base.context, ...overrides.context },
    snapshots: { ...base.snapshots, ...overrides.snapshots },
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
    app = buildServer(chatConfig(), { logger: false });

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
    app = buildServer(chatConfig(), { logger: false });

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
    app = buildServer(chatConfig(), { logger: false });

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
    app = buildServer(chatConfig(), { logger: false });

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
    app = buildServer(chatConfig(), { logger: false });

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

  it("persists context and chat finalization metadata before enqueue", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const observed: {
      queuedRun?: Record<string, unknown>;
      persisted?: Record<string, unknown>;
      jobSawSnapshot?: boolean;
    } = {};
    __setAgentChatServicesFactoryForTests(() =>
      services({
        context: {
          async fetchCandidates() {
            return {
              allowed_sources: ["memory"],
              max_tokens: 4000,
              max_items: 20,
              context_policy_applied: true,
              items: [{
                item_type: "memory",
                item_id: "memory-1",
                title: "A memory",
                excerpt: "remember this",
                score: 0.8,
                reason: "approved_memory",
                token_count: 3,
                metadata: {},
              }],
            };
          },
        },
        backends: {
          async resolveBinding() {
            return {
              runtime_profile_id: "runtime-profile-1",
              adapter_type: "claude_code",
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
              context_snapshot_id: "snapshot-1",
            };
          },
        },
        snapshots: {
          async persistChatSnapshot(input) {
            observed.persisted = input as unknown as Record<string, unknown>;
          },
        },
        jobs: {
          async enqueue() {
            observed.jobSawSnapshot = Boolean(observed.persisted);
          },
        },
      }),
    );
    app = buildServer(chatConfig(), { logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "Hi" },
    });

    expect(response.statusCode).toBe(202);
    expect(String(observed.queuedRun?.prompt)).toContain("remember this");
    expect(observed.queuedRun?.model_override_json).toMatchObject({
      chat_context_preamble: expect.stringContaining("remember this"),
      conversation_window_version: "conversation_window.v1",
      conversation_backend: {
        schema_version: "conversation_backend.v1",
        runtime_profile_id: "runtime-profile-1",
        adapter_type: "claude_code",
        credential_profile_id: "credential-1",
      },
      conversation_runtime: {
        schema_version: "conversation_runtime.v1",
        binding_id: "binding-1",
        runtime_state_key: "11111111-1111-4111-8111-111111111111",
        runtime_session_id: null,
        context_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        replay_prompt: expect.stringContaining("remember this"),
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
    expect(observed.persisted).toMatchObject({
      contextSnapshotId: "snapshot-1",
      spaceId: "space-1",
      runId: "run-1",
    });
    expect(observed.jobSawSnapshot).toBe(true);
  });

  it("sends only the increment when a CLI conversation session can resume", async () => {
    __setAgentChatIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let queuedRun: Record<string, unknown> | undefined;
    __setAgentChatServicesFactoryForTests(() =>
      services({
        sessions: {
          async listRecentMessagesForContext() {
            return [{
              id: "message-old",
              session_id: "session-1",
              space_id: "space-1",
              user_id: "user-1",
              role: "assistant",
              content: "OLD HISTORY",
              metadata_json: null,
              created_at: "2026-06-14T09:00:00.000Z",
            }];
          },
        },
        backends: {
          async resolveBinding() {
            return {
              runtime_profile_id: "runtime-profile-1",
              adapter_type: "opencode",
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
    app = buildServer(chatConfig(), { logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent-1/chat",
      payload: { message: "NEW TURN" },
    });

    expect(response.statusCode).toBe(202);
    expect(queuedRun?.prompt).toContain("NEW TURN");
    expect(queuedRun?.prompt).not.toContain("OLD HISTORY");
    expect(queuedRun?.model_override_json).toMatchObject({
      conversation_runtime: {
        runtime_session_id: "ses_existing-opaque",
        replay_prompt: expect.stringContaining("OLD HISTORY"),
      },
    });
  });

  it("changes the runtime fingerprint when an in-place backend config changes", async () => {
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
    app = buildServer(chatConfig(), { logger: false });

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

    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });
});
