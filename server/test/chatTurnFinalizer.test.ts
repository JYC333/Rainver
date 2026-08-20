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

function continuity(onFinalize?: () => void) {
  return {
    async finalizeChatTurn() {
      onFinalize?.();
      return { space_id: "space-1", work_context_scope_id: "run-1" } as never;
    },
  };
}

describe("finalizeChatTurn", () => {
  it("persists one idempotent assistant message before publishing completion", async () => {
    const calls: string[] = [];
    const events: RunEventInput[] = [];
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
        continuity: continuity(() => calls.push("continuity")),
      },
    );

    expect(calls).toEqual(["message", "continuity", "event"]);
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
    let checkpoints = 0;
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
      continuity: continuity(() => { checkpoints += 1; }),
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

    expect({ roomWrites, genericWrites, checkpoints }).toEqual({
      roomWrites: 1,
      genericWrites: 0,
      checkpoints: 1,
    });
    expect(events).toHaveLength(1);
  });

  it("publishes usable degraded Room output instead of a synthetic failure", async () => {
    const events: RunEventInput[] = [];
    const messages: Array<{ content: string; metadata?: Record<string, unknown> | null }> = [];
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
        status: "degraded",
        run_group_id: "group-1",
        output_json: {
          schema_version: "run_output.v1",
          status: "succeeded",
          summary: "Here is the complete recommendation.",
          result: {
            managed_tool_calls: [{
              ok: false,
              tool_name: "inquiry.record_conclusion",
              error_code: "system_action_failed",
            }],
          },
          output_manifest: [],
        },
        error_json: {},
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
      }),
      {
        sessions: {
          async addAssistantMessageForRun() {
            return null;
          },
          async addRoomAgentMessageForRun(input) {
            messages.push(input);
            return {
              id: "room-degraded-1",
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
        continuity: continuity(),
        async loadActionPreviews() {
          return [];
        },
      },
    );

    expect(completion).toMatchObject({
      ok: true,
      reply: "Here is the complete recommendation.",
      assistant_message: { id: "room-degraded-1" },
    });
    expect(messages).toEqual([
      expect.objectContaining({
        content: "Here is the complete recommendation.",
        metadata: expect.objectContaining({ status: "degraded" }),
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        event_type: "chat_completed",
        status: "succeeded",
        error_code: null,
      }),
    ]);
  });

  it("explains a Room authorization pause without completing the turn", async () => {
    const events: RunEventInput[] = [];
    const messages: Array<{ content: string; metadata?: Record<string, unknown> | null }> = [];
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
        status: "waiting_for_review",
        run_group_id: "group-1",
        error_json: {
          error_code: "authorization_request_pending",
          error_text: "Access to project files requires approval.",
          authorization_request_id: "authorization-1",
        },
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
      }),
      {
        sessions: {
          async addAssistantMessageForRun() {
            return null;
          },
          async addRoomAgentMessageForRun(input) {
            messages.push(input);
            return {
              id: "room-review-1",
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

    expect(completion).toBeNull();
    expect(events).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      metadata: {
        status: "waiting_for_review",
        attention_kind: "authorization",
        authorization_request_id: "authorization-1",
      },
    });
    expect(messages[0]?.content).toContain("I need your approval before I can continue.");
    expect(messages[0]?.content).toContain("Access to project files requires approval.");
  });

  it("publishes a visible Room reply when execution fails", async () => {
    const events: RunEventInput[] = [];
    const messages: string[] = [];
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
        run_group_id: "group-1",
        output_json: null,
        error_json: {
          error_code: "run_orchestration_failed",
          error_text: "The conversation context could not be loaded.",
        },
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
      }),
      {
        sessions: {
          async addAssistantMessageForRun() {
            return null;
          },
          async addRoomAgentMessageForRun(input) {
            messages.push(input.content);
            return {
              id: "room-failure-1",
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
        continuity: continuity(),
        async loadActionPreviews() {
          return [];
        },
      },
    );

    expect(completion).toMatchObject({
      ok: false,
      error_code: "run_orchestration_failed",
    });
    expect(messages).toEqual([
      "Room task failed (run_orchestration_failed): The conversation context could not be loaded.",
    ]);
    expect(events[0]).toMatchObject({ event_type: "chat_completed", status: "failed" });
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
        continuity: continuity(),
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
        continuity: continuity(() => { sideEffects += 1; }),
      },
    );

    expect(completion).toBeNull();
    expect(sideEffects).toBe(0);
  });
});
