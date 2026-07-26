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
});
