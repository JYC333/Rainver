import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { finalizeChatTurn } from "../src/modules/runs/chatTurnFinalizer";
import type {
  RunEventInput,
  RunRecord,
} from "../src/modules/runs/repository";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "version-1",
    status: "succeeded",
    mode: "live",
    prompt: "Hello",
    instruction: null,
    project_folder_id: null,
    session_id: "session-1",
    project_id: null,
    adapter_type: "model_api",
    model_provider_id: "provider-1",
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
    output_json: {
      schema_version: "run_output.v1",
      status: "succeeded",
      summary: "Hello from the worker.",
      result: {
        materialization: [{
          kind: "artifact",
          status: "succeeded",
          artifact_id: "artifact-1",
        }],
      },
      output_manifest: [],
    },
    error_json: null,
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    started_at: null,
    ended_at: "2026-07-26T10:00:01.000Z",
    ...overrides,
  };
}

describe("finalizeChatTurn", () => {
  it("persists one idempotent assistant message before publishing completion", async () => {
    const calls: string[] = [];
    const events: RunEventInput[] = [];
    let condenseInput: Record<string, unknown> | undefined;
    const completion = await finalizeChatTurn(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      {
        async listRunEventsPage() {
          return { items: [], total: 0, limit: 1, offset: 0 };
        },
        async appendRunEvent(input) {
          calls.push("event");
          events.push(input);
          return {} as never;
        },
      },
      run(),
      {
        sessions: {
          async addAssistantMessageForRun(
            _spaceId,
            _userId,
            _sessionId,
            _runId,
            input,
          ) {
            calls.push("message");
            return {
              id: "message-assistant-1",
              session_id: "session-1",
              space_id: "space-1",
              user_id: "user-1",
              role: "assistant",
              content: input.content,
              metadata_json: input.metadata ?? null,
              created_at: "2026-07-26T10:00:02.000Z",
            };
          },
        },
        async enqueueCondense(_config, input) {
          calls.push("condense");
          condenseInput = input;
        },
      },
    );

    expect(calls).toEqual(["message", "condense", "event"]);
    expect(condenseInput).toMatchObject({
      session_id: "session-1",
      source_run_id: "run-1",
    });
    expect(completion).toMatchObject({
      schema_version: "chat_turn_completion.v1",
      session_id: "session-1",
      run_id: "run-1",
      ok: true,
      reply: "Hello from the worker.",
      assistant_message: {
        id: "message-assistant-1",
        artifact_refs: ["artifact-1"],
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        event_type: "chat_completed",
        status: "succeeded",
        metadata_json: {
          session_id: "session-1",
          user_message_id: "message-user-1",
          assistant_message_id: "message-assistant-1",
        },
      }),
    ]);
  });

  it("finalizes a Room turn through the Room writer exactly once", async () => {
    const events: RunEventInput[] = [];
    let roomWrites = 0;
    let genericWrites = 0;
    let condenseEnqueues = 0;
    const repository = {
      async listRunEventsPage() {
        return {
          items: events.filter((event) => event.event_type === "chat_completed") as never[],
          total: events.length,
          limit: 1,
          offset: 0,
        };
      },
      async appendRunEvent(input: RunEventInput) {
        events.push(input);
        return {} as never;
      },
    };
    const roomRun = run({
      run_group_id: "group-1",
      model_override_json: {
        execution_mode: "room_conversation.v1",
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: "session-1",
          user_id: "user-1",
          user_message_id: "message-user-1",
          agent_id: "agent-1",
          agent_version_id: "version-1",
          project_id: "project-1",
        },
      },
    });
    const deps = {
      sessions: {
        async addAssistantMessageForRun() {
          genericWrites += 1;
          return null;
        },
        async addRoomAgentMessageForRun(input: {
          content: string;
          metadata?: Record<string, unknown> | null;
        }) {
          roomWrites += 1;
          expect(input.metadata).toMatchObject({
            task_group_id: "group-1",
            status: "succeeded",
            artifact_refs: ["artifact-1"],
          });
          return {
            id: "room-message-1",
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
      async enqueueCondense() {
        condenseEnqueues += 1;
      },
      async loadActionPreviews() {
        return [];
      },
    };

    await expect(finalizeChatTurn(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      repository,
      roomRun,
      deps,
    )).resolves.toMatchObject({
      ok: true,
      assistant_message: { id: "room-message-1" },
    });
    await expect(finalizeChatTurn(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      repository,
      roomRun,
      deps,
    )).resolves.toBeNull();

    expect({ roomWrites, genericWrites, condenseEnqueues }).toEqual({
      roomWrites: 1,
      genericWrites: 0,
      condenseEnqueues: 1,
    });
    expect(events).toHaveLength(1);
  });

  it("publishes a failed completion without inserting an assistant message", async () => {
    let messageWrites = 0;
    const events: RunEventInput[] = [];
    const completion = await finalizeChatTurn(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      {
        async listRunEventsPage() {
          return { items: [], total: 0, limit: 1, offset: 0 };
        },
        async appendRunEvent(input) {
          events.push(input);
          return {} as never;
        },
      },
      run({
        status: "failed",
        output_json: null,
        error_json: {
          error_code: "model_provider_required",
          error_text: "No model provider is configured.",
        },
      }),
      {
        sessions: {
          async addAssistantMessageForRun() {
            messageWrites += 1;
            return null;
          },
        },
      },
    );

    expect(messageWrites).toBe(0);
    expect(completion).toMatchObject({
      ok: false,
      error_code: "model_provider_required",
      error: "No model provider is configured.",
      assistant_message: null,
    });
    expect(events[0]).toMatchObject({
      event_type: "chat_completed",
      status: "failed",
      error_code: "model_provider_required",
    });
  });

  it("ignores ordinary Runs and non-terminal chat Runs", async () => {
    let events = 0;
    const repository = {
      async listRunEventsPage() {
        return { items: [], total: 0, limit: 1, offset: 0 };
      },
      async appendRunEvent() {
        events += 1;
        return {} as never;
      },
    };
    const config = loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" });

    await expect(
      finalizeChatTurn(config, repository, run({ model_override_json: {} })),
    ).resolves.toBeNull();
    await expect(
      finalizeChatTurn(config, repository, run({ status: "running" })),
    ).resolves.toBeNull();
    expect(events).toBe(0);
  });

  it("skips all side effects when a completion event already exists", async () => {
    let sideEffects = 0;
    const completion = await finalizeChatTurn(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://unused/test" }),
      {
        async listRunEventsPage() {
          return {
            items: [{ event_type: "chat_completed" }] as never[],
            total: 1,
            limit: 1,
            offset: 0,
          };
        },
        async appendRunEvent() {
          sideEffects += 1;
          return {} as never;
        },
      },
      run(),
      {
        sessions: {
          async addAssistantMessageForRun() {
            sideEffects += 1;
            return null;
          },
        },
        async enqueueCondense() {
          sideEffects += 1;
        },
      },
    );

    expect(completion).toBeNull();
    expect(sideEffects).toBe(0);
  });
});
