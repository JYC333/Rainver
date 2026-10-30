import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveAgentActorId } from "../src/db/actorResolver.js";
import { reconcileTerminalChatRuns } from "../src/modules/runs/recovery.js";
import { MAX_CHAT_FINALIZATION_ATTEMPTS } from "../src/modules/runs/chatTurnFinalizer.js";
import {
  PgRunRepository,
  type RunEventInput,
  type RunRecord,
} from "../src/modules/runs/repository.js";
import { conversationTurnTaken } from "../src/modules/sessions/conversationRuntimeSessionRepository.js";
import { seedRun, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("terminal Chat Run reconciliation", () => {
  it("publishes chat_completed for a recovered orphaned Run", async () => {
    const events: RunEventInput[] = [];
    const run: RunRecord = {
      id: "run-orphaned",
      space_id: "space-1",
      execution_kind: "agent",
      agent_id: "agent-1",
      agent_version_id: "version-1",
      status: "orphaned",
      mode: "live",
      prompt: "hello",
      instruction: null,
      project_folder_id: null,
      session_id: "session-1",
      project_id: null,
      runtime_key: "opencode",
      model_provider_id: null,
      model_override_json: {
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: "session-1",
          user_id: "user-1",
          user_message_id: "message-user-1",
          agent_id: "agent-1",
          agent_version_id: "version-1",
          project_id: null,
        },
      },
      output_json: null,
      error_json: {
        error_code: "orphaned",
        error_text: "The worker disappeared.",
      },
      required_sandbox_level: "none",
      trigger_origin: "manual",
      instructed_by_user_id: "user-1",
      started_at: "2026-07-26T10:00:00.000Z",
      ended_at: "2026-07-26T10:05:00.000Z",
    };
    const repository = {
      async listTerminalChatRunsAwaitingCompletion() {
        return [{ id: run.id, space_id: run.space_id }];
      },
      async listWaitingRoomChatRunsAwaitingReply() {
        return [];
      },
      async getRun() {
        return run;
      },
      async listRunEventsPage() {
        return { items: [], total: 0, limit: 1, offset: 0 };
      },
      async appendRunEvent(input: RunEventInput) {
        events.push(input);
        return {} as never;
      },
    } as unknown as PgRunRepository;

    await reconcileTerminalChatRuns(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      repository,
      undefined,
      {
        async finalizeRun() {
          return {
            kind: "activity",
            status: "succeeded",
            activity_id: "finalization-1",
            metadata_json: {},
          };
        },
      },
      {
        loadActionPreviews: async () => [],
        resolveAgentActorId: async (_space: string, agentId: string) => agentId,
        continuity: {
          async finalizeChatTurn() {
            return {
              space_id: run.space_id,
              work_context_scope_id: run.id,
            } as never;
          },
        },
      },
    );

    expect(events).toEqual([
      expect.objectContaining({
        run_id: "run-orphaned",
        event_type: "chat_completed",
        status: "failed",
        error_code: "orphaned",
      }),
    ]);
  });

  it("completes the chat turn of a Run whose settlement is only owed", async () => {
    const events: RunEventInput[] = [];
    const run: RunRecord = {
      id: "run-orphaned",
      space_id: "space-1",
      execution_kind: "agent",
      agent_id: "agent-1",
      agent_version_id: "version-1",
      status: "orphaned",
      mode: "live",
      prompt: "hello",
      instruction: null,
      project_folder_id: null,
      session_id: "session-1",
      project_id: null,
      runtime_key: "opencode",
      model_provider_id: null,
      model_override_json: {
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: "session-1",
          user_id: "user-1",
          user_message_id: "message-user-1",
          agent_id: "agent-1",
          agent_version_id: "version-1",
          project_id: null,
        },
      },
      output_json: null,
      error_json: {
        error_code: "orphaned",
        error_text: "The worker disappeared.",
      },
      required_sandbox_level: "none",
      trigger_origin: "manual",
      instructed_by_user_id: "user-1",
      started_at: "2026-07-26T10:00:00.000Z",
      ended_at: "2026-07-26T10:05:00.000Z",
    };
    const repository = {
      async listTerminalChatRunsAwaitingCompletion() {
        return [{ id: run.id, space_id: run.space_id }];
      },
      async listWaitingRoomChatRunsAwaitingReply() {
        return [];
      },
      async getRun() {
        return run;
      },
      async listRunEventsPage() {
        return { items: [], total: 0, limit: 1, offset: 0 };
      },
      async appendRunEvent(input: RunEventInput) {
        events.push(input);
        return {} as never;
      },
    } as unknown as PgRunRepository;

    await reconcileTerminalChatRuns(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      repository,
      undefined,
      {
        async finalizeRun() {
          // The evaluation is durable; the settlement sweep finishes the rest.
          return {
            kind: "activity",
            status: "failed",
            error_code: "settlement_pending",
            error_message: "settlement owed",
            metadata_json: {},
          };
        },
      },
      {
        loadActionPreviews: async () => [],
        resolveAgentActorId: async (_space: string, agentId: string) => agentId,
        continuity: {
          async finalizeChatTurn() {
            return {
              space_id: run.space_id,
              work_context_scope_id: run.id,
            } as never;
          },
        },
      },
    );

    expect(events).toEqual([
      expect.objectContaining({
        run_id: "run-orphaned",
        event_type: "chat_completed",
        status: "failed",
        error_code: "orphaned",
      }),
    ]);
  });

  it("completes a chat turn whose Run died before creating an invocation authority", async () => {
    const events: RunEventInput[] = [];
    const run: RunRecord = {
      id: "run-routing-failed",
      space_id: "space-1",
      execution_kind: "agent",
      agent_id: "agent-1",
      agent_version_id: "version-1",
      status: "failed",
      mode: "live",
      prompt: "hello",
      instruction: null,
      project_folder_id: null,
      session_id: "session-1",
      project_id: null,
      runtime_key: "claude_code",
      model_provider_id: null,
      model_override_json: {
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: "session-1",
          user_id: "user-1",
          user_message_id: "message-user-1",
          agent_id: "agent-1",
          agent_version_id: "version-1",
          project_id: null,
        },
      },
      output_json: null,
      error_json: {
        error_code: "run_orchestration_failed",
        error_text: "No runtime candidate passed routing hard filters.",
      },
      required_sandbox_level: "none",
      trigger_origin: "manual",
      instructed_by_user_id: "user-1",
      started_at: "2026-08-30T10:00:00.000Z",
      ended_at: "2026-08-30T10:00:01.000Z",
    };
    const repository = {
      async listTerminalChatRunsAwaitingCompletion() {
        return [{ id: run.id, space_id: run.space_id }];
      },
      async listWaitingRoomChatRunsAwaitingReply() {
        return [];
      },
      async getRun() {
        return run;
      },
      async listRunEventsPage() {
        return { items: [], total: 0, limit: 1, offset: 0 };
      },
      async appendRunEvent(input: RunEventInput) {
        events.push(input);
        return {} as never;
      },
    } as unknown as PgRunRepository;

    await reconcileTerminalChatRuns(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      repository,
      undefined,
      {
        async finalizeRun() {
          return { kind: "activity", status: "succeeded", activity_id: "finalization-2", metadata_json: {} };
        },
      },
      {
        loadActionPreviews: async () => [],
        resolveAgentActorId: async (_space: string, agentId: string) => agentId,
        continuity: {
          async finalizeChatTurn() {
            const { InvocationAuthorityNotFoundError } = await import("../src/modules/runtimeContext/continuity/service.js");
            throw new InvocationAuthorityNotFoundError();
          },
        },
      },
    );

    // The missing authority is expected for a Run that never executed; the
    // completion must land instead of deferring forever.
    expect(events).toEqual([
      expect.objectContaining({
        run_id: "run-routing-failed",
        event_type: "chat_completed",
        status: "failed",
        error_code: "run_orchestration_failed",
      }),
    ]);
  });

  it("withholds chat completion while canonical finalization is incomplete", async () => {
    const events: RunEventInput[] = [];
    const run = {
      id: "run-1",
      space_id: "space-1",
      status: "succeeded",
      model_override_json: {
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: "session-1",
          user_id: "user-1",
          user_message_id: "message-1",
          agent_id: "agent-1",
          agent_version_id: "version-1",
        },
      },
    } as RunRecord;
    const repository = {
      async listTerminalChatRunsAwaitingCompletion() {
        return [{ id: run.id, space_id: run.space_id }];
      },
      async listWaitingRoomChatRunsAwaitingReply() {
        return [];
      },
      async getRun() {
        return run;
      },
      async appendRunEvent(input: RunEventInput) {
        events.push(input);
        return {} as never;
      },
    } as unknown as PgRunRepository;

    await reconcileTerminalChatRuns(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      repository,
      undefined,
      {
        async finalizeRun() {
          return {
            kind: "activity",
            status: "failed",
            error_code: "finalization_failed",
            error_message: "Supervisor decision is not committed.",
            metadata_json: {},
          };
        },
      },
    );

    expect(events).toEqual([]);
  });

  it("restores an explanatory reply for an existing waiting Room Run", async () => {
    const messages: string[] = [];
    const run = {
      id: "run-waiting",
      space_id: "space-1",
      execution_kind: "agent",
      agent_id: "agent-1",
      agent_version_id: "version-1",
      run_group_id: "group-1",
      status: "waiting_for_review",
      error_json: {
        error_code: "run_orchestration_failed",
        error_text: "Conversation context loading failed.",
        supervisor_review: true,
      },
      model_override_json: {
        execution_mode: "room_conversation.v1",
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: "session-1",
          user_id: "user-1",
          user_message_id: "message-1",
          agent_id: "agent-1",
          agent_version_id: "version-1",
          project_id: "project-1",
        },
      },
    } as RunRecord;
    const repository = {
      async listTerminalChatRunsAwaitingCompletion() {
        return [];
      },
      async listWaitingRoomChatRunsAwaitingReply() {
        return [{ id: run.id, space_id: run.space_id }];
      },
      async getRun() {
        return run;
      },
    } as unknown as PgRunRepository;
    let materializerCalls = 0;

    await reconcileTerminalChatRuns(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      repository,
      undefined,
      {
        async finalizeRun() {
          materializerCalls += 1;
          return { kind: "activity", status: "succeeded", metadata_json: {} };
        },
      },
      {
        sessions: {
          async addAssistantMessageForRun() {
            return null;
          },
          async addRoomAgentMessageForRun(input) {
            messages.push(input.content);
            return {
              id: "message-review",
              session_id: "session-1",
              space_id: "space-1",
              user_id: null,
              sender_agent_id: "agent-1",
              role: "assistant",
              content: input.content,
              metadata_json: input.metadata ?? null,
              created_at: "2026-07-26T10:00:02.000Z",
            };
          },
        },
      },
    );

    expect(materializerCalls).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("need your decision before retrying");
    expect(messages[0]).toContain("Conversation context loading failed.");
  });
});

describe("terminal Chat Run whose finalization keeps failing", () => {
  const db = useTestDatabase(import.meta.filename);

  it("releases the conversation with a visible failed completion once the retry bound is reached", async () => {
    const space = randomUUID();
    const owner = randomUUID();
    const agent = randomUUID();
    const runId = randomUUID();
    const session = randomUUID();
    await seedSpaceOwnerProject(db.pool, { space, owner, project: randomUUID() });
    await seedRun(db.pool, { id: runId, space, owner, agent, version: randomUUID() });
    await db.pool.query(
      `INSERT INTO sessions (id, space_id, user_id, agent_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [session, space, owner, agent],
    );
    await db.pool.query(
      `UPDATE runs SET session_id = $2, model_override_json = $3::jsonb, output_json = $4::jsonb WHERE id = $1`,
      [runId, session, JSON.stringify({
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: session,
          user_id: owner,
          user_message_id: randomUUID(),
          agent_id: agent,
          agent_version_id: "unused",
          project_id: null,
        },
      }), JSON.stringify({ schema_version: "run_output.v1", status: "succeeded", summary: "Done." })],
    );
    const runs = new PgRunRepository(db.pool);
    const sweep = () => reconcileTerminalChatRuns(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      runs,
      undefined,
      { async finalizeRun() { return { kind: "activity", status: "succeeded", activity_id: "finalization-1", metadata_json: {} }; } },
      {
        loadActionPreviews: async () => [],
        resolveAgentActorId: (spaceId, agentId) => resolveAgentActorId(db.pool, spaceId, agentId),
        sessions: {
          async addAssistantMessageForRun() {
            throw new Error("message store rejected the reply");
          },
        },
      },
    );
    const events = async () => (await db.pool.query<{ event_type: string; status: string; error_code: string | null; error_message: string | null }>(
      `SELECT event_type, status, error_code, error_message FROM run_events WHERE run_id = $1 ORDER BY event_index`,
      [runId],
    )).rows;

    expect(await conversationTurnTaken(db.pool, space, session)).toBe(true);
    for (let attempt = 1; attempt < MAX_CHAT_FINALIZATION_ATTEMPTS; attempt += 1) {
      await sweep();
      expect(await conversationTurnTaken(db.pool, space, session)).toBe(true);
    }
    expect(await events()).toEqual(Array.from({ length: MAX_CHAT_FINALIZATION_ATTEMPTS - 1 }, () => expect.objectContaining({
      event_type: "warning",
      error_code: "chat_finalization_failed",
      error_message: "message store rejected the reply",
    })));

    await sweep();
    expect(await conversationTurnTaken(db.pool, space, session)).toBe(false);
    expect((await events()).at(-1)).toMatchObject({
      event_type: "chat_completed",
      status: "failed",
      error_code: "chat_finalization_failed",
      error_message: expect.stringContaining("message store rejected the reply"),
    });
    expect(await runs.listTerminalChatRunsAwaitingCompletion()).toEqual([]);
  });
});
