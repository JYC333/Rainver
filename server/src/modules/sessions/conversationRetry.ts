import { createHash } from "node:crypto";
import type { Queryable } from "./repository.js";
import { HttpError } from "../routeUtils/common.js";

export function requireConversationIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(422, "Idempotency-Key is required for conversation retry");
  }
  const key = value.trim();
  if (key.length > 128) throw new HttpError(422, "Idempotency-Key must be at most 128 characters");
  return key;
}

export function conversationRetryFingerprint(input: {
  kind: "direct" | "room";
  runId: string;
  sessionId: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Serialize a retry under its scoped key and replay the committed response. */
export async function withConversationRetryIdempotency<T>(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    key: string;
    fingerprint: string;
    sessionId: string;
    messageId: string;
    runId: string;
  },
  work: () => Promise<T>,
): Promise<{ value: T; reused: boolean }> {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`conversation-retry:${input.spaceId}:${input.userId}:${input.key}`],
  );
  const existing = await db.query<{ request_fingerprint: string; response_json: string | null }>(
    `SELECT request_fingerprint, response_json
       FROM conversation_turn_idempotencies
      WHERE space_id = $1 AND user_id = $2 AND idempotency_key = $3
      LIMIT 1`,
    [input.spaceId, input.userId, input.key],
  );
  const prior = existing.rows[0];
  if (prior) {
    if (prior.request_fingerprint !== input.fingerprint) {
      throw new HttpError(409, "Idempotency-Key was already used for a different conversation retry");
    }
    if (!prior.response_json) throw new HttpError(409, "The earlier conversation retry is incomplete; try again");
    return { value: JSON.parse(prior.response_json) as T, reused: true };
  }

  const value = await work();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO conversation_turn_idempotencies
       (id, space_id, user_id, idempotency_key, request_fingerprint,
        session_id, message_id, run_id, response_json, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [input.spaceId, input.userId, input.key, input.fingerprint, input.sessionId, input.messageId, input.runId, JSON.stringify(value), now],
  );
  return { value, reused: false };
}
