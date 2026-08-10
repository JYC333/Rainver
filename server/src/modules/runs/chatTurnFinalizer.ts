import type {
  AssistantMessage,
  ChatTurnCompletion,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { loadProjectChatActionPreviews } from "../agents/projectChatActionPreviews";
import { PgSessionRepository } from "../sessions/repository";
import {
  ManagedSemanticCheckpointProvider,
  RuntimeContextContinuityService,
} from "../runtimeContext";
import { runOutputResult } from "./orchestrationResults";
import {
  PgRunRepository,
  type RunRecord,
} from "./repository";

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "degraded",
  "cancelled",
  "orphaned",
]);

interface ChatTurnMetadata {
  schema_version: "chat_turn.v1";
  session_id: string;
  user_id: string;
  user_message_id: string;
  agent_id: string;
  agent_version_id: string;
  project_id: string | null;
}

export interface ChatTurnFinalizerDeps {
  sessions?: Pick<PgSessionRepository, "addAssistantMessageForRun">
    & Partial<Pick<PgSessionRepository, "addRoomAgentMessageForRun">>;
  loadActionPreviews?: typeof loadProjectChatActionPreviews;
  continuity?: Pick<RuntimeContextContinuityService, "finalizeChatTurn">;
}

export async function finalizeChatTurn(
  config: ServerConfig,
  repository: Pick<PgRunRepository, "appendRunEvent" | "listRunEventsPage">,
  run: RunRecord,
  deps: ChatTurnFinalizerDeps = {},
): Promise<ChatTurnCompletion | null> {
  const metadata = chatTurnMetadata(run.model_override_json);
  if (!metadata || !TERMINAL_STATUSES.has(run.status)) return null;
  const existingCompletion = await repository.listRunEventsPage(
    run.space_id,
    run.id,
    {
      from_event_index: 0,
      limit: 1,
      event_type: "chat_completed",
      status: null,
    },
  );
  if (existingCompletion.items.length > 0) return null;

  const outcome = chatOutcome(run);
  const actionPreviews = metadata.project_id
    ? await (deps.loadActionPreviews ?? loadProjectChatActionPreviews)(
        getDbPool(config.databaseUrl!),
        run.space_id,
        run.id,
      )
    : [];
  let assistantMessage: AssistantMessage | null = null;
  let terminalMessageId: string | null = null;

  if (outcome.ok) {
    const artifactRefs = artifactReferences(run.output_json);
    const sessions = deps.sessions ?? PgSessionRepository.fromConfig(config);
    const stored = isRoomConversationRun(run)
      ? await requiredRoomMessageWriter(sessions)({
          space_id: run.space_id,
          session_id: metadata.session_id,
          sender_agent_id: metadata.agent_id,
          run_id: run.id,
          content: outcome.reply,
          metadata: {
            ...(run.run_group_id ? { task_group_id: run.run_group_id } : {}),
            status: run.status,
            ...(artifactRefs.length > 0 ? { artifact_refs: artifactRefs } : {}),
            ...(actionPreviews.length > 0 ? { action_previews: actionPreviews } : {}),
          },
        })
      : await sessions.addAssistantMessageForRun(
          run.space_id,
          metadata.user_id,
          metadata.session_id,
          run.id,
          {
            content: outcome.reply,
            metadata: {
              ...(artifactRefs.length > 0 ? { artifact_refs: artifactRefs } : {}),
              ...(actionPreviews.length > 0 ? { action_previews: actionPreviews } : {}),
            },
          },
        );
    if (!stored) {
      throw new Error(
        `Chat session '${metadata.session_id}' is unavailable during Run finalization`,
      );
    }
    assistantMessage = {
      schema_version: "assistant_message.v1",
      id: stored.id,
      session_id: metadata.session_id,
      run_id: run.id,
      content: outcome.reply,
      artifact_refs: artifactRefs,
      tool_call_refs: actionPreviews.flatMap((preview) =>
        preview.tool_call_id ? [preview.tool_call_id] : []),
      created_at: stored.created_at,
    };
    terminalMessageId = stored.id;
  } else if (isRoomConversationRun(run)) {
    const sessions = deps.sessions ?? PgSessionRepository.fromConfig(config);
    const stored = await requiredRoomMessageWriter(sessions)({
      space_id: run.space_id,
      session_id: metadata.session_id,
      sender_agent_id: metadata.agent_id,
      run_id: run.id,
      content: `Room task failed (${outcome.errorCode}): ${outcome.error}`.slice(
        0,
        2_000,
      ),
      metadata: {
        ...(run.run_group_id ? { task_group_id: run.run_group_id } : {}),
        status: run.status,
        error_code: outcome.errorCode,
      },
    });
    if (!stored) {
      throw new Error(
        `Room session '${metadata.session_id}' is unavailable during Run finalization`,
      );
    }
    terminalMessageId = stored.id;
  }

  const continuity = deps.continuity ?? productionContinuity(config);
  await continuity.finalizeChatTurn({
    invocationId: run.id,
    messageId: terminalMessageId,
    failedRun: !outcome.ok,
  });
  const completion: ChatTurnCompletion = {
    schema_version: "chat_turn_completion.v1",
    session_id: metadata.session_id,
    run_id: run.id,
    ok: outcome.ok,
    reply: outcome.ok ? outcome.reply : null,
    error: outcome.ok ? null : outcome.error,
    error_code: outcome.ok ? null : outcome.errorCode,
    assistant_message: assistantMessage,
    ...(actionPreviews.length > 0 ? { action_previews: actionPreviews } : {}),
  };
  await repository.appendRunEvent({
    run_id: run.id,
    space_id: run.space_id,
    event_type: "chat_completed",
    status: outcome.ok ? "succeeded" : "failed",
    actor_id: run.agent_id,
    summary: outcome.ok
      ? "Chat turn completed."
      : "Chat turn completed without an assistant reply.",
    error_code: outcome.ok ? null : outcome.errorCode,
    error_message: outcome.ok ? null : outcome.error,
    metadata_json: {
      session_id: metadata.session_id,
      user_message_id: metadata.user_message_id,
      assistant_message_id: assistantMessage?.id ?? null,
    },
  });
  return completion;
}

function productionContinuity(config: ServerConfig): RuntimeContextContinuityService {
  if (!config.databaseUrl) throw new Error("Runtime Context continuity requires the database");
  const db = getDbPool(config.databaseUrl);
  return new RuntimeContextContinuityService(db, new ManagedSemanticCheckpointProvider(db, config));
}

function requiredRoomMessageWriter(
  sessions: Pick<PgSessionRepository, "addAssistantMessageForRun">
    & Partial<Pick<PgSessionRepository, "addRoomAgentMessageForRun">>,
): PgSessionRepository["addRoomAgentMessageForRun"] {
  if (!sessions.addRoomAgentMessageForRun) {
    throw new Error("Room chat finalization requires the Room message writer");
  }
  return sessions.addRoomAgentMessageForRun.bind(sessions);
}

function isRoomConversationRun(run: RunRecord): boolean {
  return recordValue(run.model_override_json).execution_mode
    === "room_conversation.v1";
}

function chatTurnMetadata(value: unknown): ChatTurnMetadata | null {
  const root = recordValue(value);
  const chatTurn = recordValue(root.chat_turn);
  if (
    chatTurn.schema_version !== "chat_turn.v1" ||
    !stringValue(chatTurn.session_id) ||
    !stringValue(chatTurn.user_id) ||
    !stringValue(chatTurn.user_message_id) ||
    !stringValue(chatTurn.agent_id) ||
    !stringValue(chatTurn.agent_version_id)
  ) {
    return null;
  }
  return {
    schema_version: "chat_turn.v1",
    session_id: stringValue(chatTurn.session_id)!,
    user_id: stringValue(chatTurn.user_id)!,
    user_message_id: stringValue(chatTurn.user_message_id)!,
    agent_id: stringValue(chatTurn.agent_id)!,
    agent_version_id: stringValue(chatTurn.agent_version_id)!,
    project_id: stringValue(chatTurn.project_id),
  };
}

function chatOutcome(
  run: RunRecord,
): { ok: true; reply: string } | {
  ok: false;
  error: string;
  errorCode: string;
} {
  if (run.status !== "succeeded") {
    const errorJson = recordValue(run.error_json);
    const errorCode = stringValue(errorJson.error_code) ?? "run_failed";
    const error =
      stringValue(errorJson.error_text) ??
      stringValue(errorJson.error) ??
      `The assistant run ended with status '${run.status}'.`;
    return { ok: false, error, errorCode };
  }
  const outputEnvelope = recordValue(run.output_json);
  const output = runOutputResult(run.output_json);
  return {
    ok: true,
    reply:
      stringValue(outputEnvelope.summary) ??
      stringValue(output.output_text) ??
      "",
  };
}

function artifactReferences(value: unknown): string[] {
  const materialization = runOutputResult(value).materialization;
  if (!Array.isArray(materialization)) return [];
  return [...new Set(materialization.flatMap((item) => {
    const artifactId = stringValue(recordValue(item).artifact_id);
    return artifactId ? [artifactId] : [];
  }))];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
