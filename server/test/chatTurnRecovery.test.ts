import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { reconcileTerminalChatRuns } from "../src/modules/jobs/workerRuntime";
import type {
  PgRunRepository,
  RunEventInput,
  RunRecord,
} from "../src/modules/runs/repository";

describe("terminal Chat Run reconciliation", () => {
  it("publishes chat_completed for a recovered orphaned Run", async () => {
    const events: RunEventInput[] = [];
    const run: RunRecord = {
      id: "run-orphaned",
      space_id: "space-1",
      agent_id: "agent-1",
      agent_version_id: "version-1",
      status: "orphaned",
      mode: "live",
      prompt: "hello",
      instruction: null,
      project_folder_id: null,
      session_id: "session-1",
      project_id: null,
      adapter_type: "model_api",
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
