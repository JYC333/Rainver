import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

export interface ConversationRuntimeSession {
  binding_id: string;
  runtime_state_key: string;
  runtime_session_id: string | null;
  runtime_context_fingerprint: string | null;
  runtime_message_cursor_id?: string | null;
  retired_runtime_state_key: string | null;
}

interface RuntimeSessionRow {
  binding_id: string;
  runtime_state_key: string;
  runtime_session_id: string | null;
  runtime_context_fingerprint: string | null;
  runtime_message_cursor_id?: string | null;
}

export class ConversationTurnInProgressError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("The previous conversation turn is still in progress");
    this.name = "ConversationTurnInProgressError";
  }
}

/**
 * `claimTurn`'s throw site is several call frames below any caller that
 * needs to distinguish "the turn is transiently busy, retry" from every
 * other failure — and `rooms/service.ts`'s `dispatchRoomMessage` re-wraps
 * this specific error into a generic `HttpError(409, ...)` for its own
 * (correct, HTTP-facing) purposes on the way up, which erases the
 * `instanceof` check. Duck-typed on status code + exact message rather than
 * importing `HttpError` here, to avoid coupling this low-level module to
 * the HTTP error shape. `statusCode === 409` alone is not sufficient — other
 * unrelated failures in the same dispatch path also use 409.
 */
export function isConversationTurnInProgressError(error: unknown): boolean {
  if (error instanceof ConversationTurnInProgressError) return true;
  const candidate = error as { statusCode?: unknown; message?: unknown } | null;
  return Boolean(
    candidate
    && candidate.statusCode === 409
    && candidate.message === new ConversationTurnInProgressError().message,
  );
}

export class PgConversationRuntimeSessionRepository {
  constructor(private readonly db: Queryable) {}

  async claimTurn(input: {
    space_id: string;
    session_id: string;
    user_id: string;
  }): Promise<void> {
    const lockKey = `${input.space_id}:${input.session_id}:${input.user_id}`;
    await this.db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockKey],
    );
    const active = await this.db.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM runs
          WHERE space_id = $1
            AND session_id = $2
            AND model_override_json->'chat_turn'->>'schema_version' = 'chat_turn.v1'
            AND model_override_json->'chat_turn'->>'user_id' = $3
            AND status IN (
              'queued', 'running', 'cancelling',
              'waiting_for_review', 'waiting_for_dependency'
            )
       ) AS active`,
      [input.space_id, input.session_id, input.user_id],
    );
    if (active.rows[0]?.active) throw new ConversationTurnInProgressError();
  }

  async prepare(input: {
    binding_id: string;
    space_id: string;
    session_id: string;
    user_id: string;
    agent_id: string;
    runtime_state_key: string;
    context_fingerprint: string;
  }): Promise<ConversationRuntimeSession> {
    const replacementStateKey = randomUUID();
    const result = await this.db.query<RuntimeSessionRow>(
      `UPDATE session_conversation_backends
          SET runtime_state_key = CASE
                WHEN runtime_session_id IS NOT NULL
                 AND runtime_context_fingerprint IS DISTINCT FROM $6
                THEN $7
                ELSE runtime_state_key
              END,
              runtime_session_id = CASE
                WHEN runtime_session_id IS NOT NULL
                 AND runtime_context_fingerprint IS DISTINCT FROM $6
                THEN NULL
                ELSE runtime_session_id
              END,
              runtime_context_fingerprint = CASE
                WHEN runtime_session_id IS NOT NULL
                 AND runtime_context_fingerprint IS DISTINCT FROM $6
                THEN NULL
                ELSE runtime_context_fingerprint
              END,
              runtime_message_cursor_id = CASE
                WHEN runtime_session_id IS NOT NULL
                 AND runtime_context_fingerprint IS DISTINCT FROM $6
                THEN NULL
                ELSE runtime_message_cursor_id
              END,
              runtime_session_updated_at = CASE
                WHEN runtime_session_id IS NOT NULL
                 AND runtime_context_fingerprint IS DISTINCT FROM $6
                THEN NULL
                ELSE runtime_session_updated_at
              END,
              updated_at = now()
        WHERE id = $1
          AND space_id = $2
          AND session_id = $3
          AND user_id = $4
          AND agent_id = $5
      RETURNING id AS binding_id, runtime_state_key, runtime_session_id,
                runtime_context_fingerprint, runtime_message_cursor_id`,
      [
        input.binding_id,
        input.space_id,
        input.session_id,
        input.user_id,
        input.agent_id,
        input.context_fingerprint,
        replacementStateKey,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("conversation runtime session binding was not found");
    return {
      ...row,
      retired_runtime_state_key:
        row.runtime_state_key !== input.runtime_state_key
          ? input.runtime_state_key
          : null,
    };
  }

  async record(input: {
    binding_id: string;
    runtime_state_key: string;
    runtime_session_id: string;
    context_fingerprint: string;
    message_cursor_id?: string | null;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE session_conversation_backends
          SET runtime_session_id = $3,
              runtime_context_fingerprint = $4,
              runtime_message_cursor_id = $5,
              runtime_session_updated_at = now(),
              updated_at = now()
        WHERE id = $1
          AND runtime_state_key = $2`,
      [
        input.binding_id,
        input.runtime_state_key,
        input.runtime_session_id,
        input.context_fingerprint,
        input.message_cursor_id ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async invalidate(input: {
    binding_id: string;
    runtime_state_key: string;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE session_conversation_backends
          SET runtime_state_key = $3,
              runtime_session_id = NULL,
              runtime_context_fingerprint = NULL,
              runtime_message_cursor_id = NULL,
              runtime_session_updated_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND runtime_state_key = $2`,
      [input.binding_id, input.runtime_state_key, randomUUID()],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
