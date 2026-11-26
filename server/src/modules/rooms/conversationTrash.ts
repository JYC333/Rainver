/**
 * Room conversation recycle bin (`.agent/modules/rooms.md`, "Conversation
 * recycle bin"): restore within the retention window and the bounded
 * background purge after it.
 *
 * Deletion itself is `PgRoomRepository.deleteConversation`: it records
 * `deleted_at` and the list the conversation came from. Only rows the bin put
 * there are restorable or purgeable; a legacy `deleted` row (no `deleted_at`)
 * is left exactly as it is.
 */
import type { Pool } from "../../db/pool.js";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { PgConversationRuntimeSessionRepository } from "../sessions/conversationRuntimeSessionRepository.js";
import { lockRoomConversationQueue } from "./messageQueue.js";

export const ROOM_CONVERSATION_TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_INTERVAL_SQL = `interval '${ROOM_CONVERSATION_TRASH_RETENTION_DAYS} days'`;
/** One scheduler pass purges at most this many conversations, each in its own transaction. */
export const ROOM_CONVERSATION_PURGE_BATCH = 20;
/**
 * A failed purge is retried after `base * 2^(attempts - 1)`, capped, and is
 * picked only after conversations with fewer failed attempts, so one that
 * keeps failing neither holds a batch slot nor starves later deadlines.
 */
export const PURGE_RETRY_BASE_SQL = "interval '1 hour'";
export const PURGE_RETRY_MAX_SQL = "interval '7 days'";

/**
 * Tables whose rows outlive the conversation: Project execution records,
 * audit/usage, Host workspace and Gmail digest lifecycles. The purge never
 * deletes or rewrites them, and any one of them keeps the session row as a
 * tombstone so their references stay valid.
 */
export const PROTECTED_SESSION_REFERENCES = [
  "runs",
  "run_steps",
  "agent_run_groups",
  "activity_records",
  "execution_workspaces",
  "host_threads",
  "gmail_digests",
  "token_usage_events",
] as const;

/** The conversation's own content, removed by the purge in this order. */
export const EXCLUSIVE_SESSION_CONTENT = [
  "room_queued_messages",
  "conversation_folder_access_grants",
  "message_input_parts",
  "conversation_file_snapshots",
  "conversation_input_resources",
  "room_discussions",
  "messages",
] as const;

/**
 * Execution configuration of the conversation itself. Kept on a tombstone,
 * removed by cascade with the row when nothing protected remains.
 */
export const SESSION_BINDING_REFERENCES = [
  "session_conversation_backends",
  "conversation_execution_contexts",
  "room_conversation_recipients",
  "conversation_turn_idempotencies",
  // A tombstone keeps who could read it; nothing is readable once it is gone.
  "room_conversation_audiences",
] as const;

/**
 * Messages that a retained record names, by `table.column`, with the
 * conversation column that scopes it. The purge keeps each such message and
 * its ancestors as an empty row, because the foreign key would otherwise
 * block the delete or cascade the record away. Every other foreign key to
 * `messages` is dropped with the conversation's own content
 * (`DISPOSABLE_MESSAGE_REFERENCES`); `roomConversationTrashDb.test.ts`
 * fails when one is classified in neither list.
 */
export const MESSAGE_ANCHOR_REFERENCES = [
  { table: "agent_run_groups", column: "trigger_message_id", session: "session_id" },
  { table: "room_discussions", column: "origin_message_id", session: "session_id" },
  { table: "gmail_private_checks", column: "source_message_id", session: "source_session_id" },
] as const;

/** Foreign keys to `messages` whose rows are purged first or are cleared by `SET NULL`. */
export const DISPOSABLE_MESSAGE_REFERENCES = [
  "conversation_file_snapshots.message_id",
  "conversation_input_media.message_id",
  "conversation_input_resources.message_id",
  "conversation_turn_idempotencies.message_id",
  "message_input_parts.message_id",
  "messages.parent_message_id",
  "room_discussions.conclusion_message_id",
  "room_queued_messages.released_message_id",
  "sessions.head_message_id",
] as const;

/**
 * A row the bin can still restore: deleted through the bin, not purged, inside
 * the window. A decision taken under the conversation locks passes
 * `clock_timestamp()`: `now()` is the transaction's start, which can precede
 * the deadline by however long the locks took to acquire.
 */
export function restorableFromTrashSql(alias: string, clock: "now()" | "clock_timestamp()" = "now()"): string {
  return `${alias}.deleted_at IS NOT NULL AND ${alias}.purged_at IS NULL
    AND ${alias}.deleted_at > ${clock} - ${TRASH_RETENTION_INTERVAL_SQL}`;
}

export type TrashRestoreResult = "restored" | "missing" | "expired";

/**
 * Return a deleted conversation to the list it was deleted from. The caller
 * holds the conversation queue and runtime locks and has rechecked Project
 * writer authority, exactly as for deletion.
 */
export async function restoreConversationFromTrash(
  db: Queryable,
  spaceId: string,
  roomId: string,
  sessionId: string,
): Promise<TrashRestoreResult> {
  const current = await db.query<{ restorable: boolean }>(
    `SELECT (${restorableFromTrashSql("s", "clock_timestamp()")}) AS restorable
       FROM sessions s
      WHERE s.space_id = $1 AND s.room_id = $2 AND s.id = $3
        AND s.status = 'deleted' AND s.deleted_at IS NOT NULL
      FOR UPDATE`,
    [spaceId, roomId, sessionId],
  );
  const row = current.rows[0];
  if (!row) return "missing";
  if (!row.restorable) return "expired";
  await db.query(
    `UPDATE sessions
        SET status = deleted_from_status, deleted_from_status = NULL, deleted_at = NULL,
            purge_attempts = 0, purge_retry_at = NULL, updated_at = now()
      WHERE space_id = $1 AND room_id = $2 AND id = $3`,
    [spaceId, roomId, sessionId],
  );
  return "restored";
}

export interface RoomConversationPurgeResult {
  /** Session rows deleted together with everything that referenced only them. */
  removed: number;
  /** Content purged, row kept because Project records still reference it. */
  tombstoned: number;
  failed: number;
}

/**
 * Purge conversations whose retention window has ended, at most `limit` per
 * call: those with the fewest failed attempts first, then oldest first. Each
 * conversation is its own transaction, so one failure neither rolls back nor
 * blocks the others. A failure is counted on the row and backs it off
 * (`PURGE_RETRY_BASE_SQL`), and failures are reported after the batch so the
 * scheduler records them.
 */
export async function purgeExpiredRoomConversations(
  pool: Pool,
  options: { limit?: number; onFailure?: (sessionId: string, error: unknown) => void } = {},
): Promise<RoomConversationPurgeResult> {
  const due = await pool.query<{ space_id: string; id: string }>(
    `SELECT s.space_id, s.id
       FROM sessions s
      WHERE s.status = 'deleted' AND s.room_id IS NOT NULL
        AND s.deleted_at IS NOT NULL AND s.purged_at IS NULL
        AND s.deleted_at <= now() - ${TRASH_RETENTION_INTERVAL_SQL}
        AND (s.purge_retry_at IS NULL OR s.purge_retry_at <= now())
      ORDER BY s.purge_attempts ASC, s.deleted_at ASC, s.id ASC
      LIMIT $1`,
    [options.limit ?? ROOM_CONVERSATION_PURGE_BATCH],
  );
  const result: RoomConversationPurgeResult = { removed: 0, tombstoned: 0, failed: 0 };
  for (const row of due.rows) {
    try {
      const outcome = await withQueryableTransaction(pool, (tx) => purgeConversation(tx, row.space_id, row.id));
      if (outcome === "removed") result.removed += 1;
      else if (outcome === "tombstoned") result.tombstoned += 1;
    } catch (error) {
      result.failed += 1;
      options.onFailure?.(row.id, error);
      await recordPurgeFailure(pool, row.space_id, row.id).catch((recordError: unknown) => options.onFailure?.(row.id, recordError));
    }
  }
  if (result.failed > 0) {
    throw new Error(`Room conversation purge failed for ${result.failed} conversation(s)`);
  }
  return result;
}

/** Count a failed attempt and defer the next one; the purge transaction itself rolled back. */
async function recordPurgeFailure(pool: Pool, spaceId: string, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions
        SET purge_attempts = purge_attempts + 1,
            purge_retry_at = now() + LEAST(${PURGE_RETRY_BASE_SQL} * power(2, purge_attempts), ${PURGE_RETRY_MAX_SQL})
      WHERE space_id = $1 AND id = $2
        AND status = 'deleted' AND deleted_at IS NOT NULL AND purged_at IS NULL`,
    [spaceId, sessionId],
  );
}

async function purgeConversation(
  db: Queryable,
  spaceId: string,
  sessionId: string,
): Promise<"removed" | "tombstoned" | "skipped"> {
  // The same locks, in the same order, as delete and restore: a restore that
  // won the race leaves nothing due here, and one that lost finds it purged.
  await lockRoomConversationQueue(db, spaceId, sessionId);
  await new PgConversationRuntimeSessionRepository(db).lockConversation(spaceId, sessionId);
  const locked = await db.query(
    `SELECT s.id FROM sessions s
      WHERE s.space_id = $1 AND s.id = $2
        AND s.status = 'deleted' AND s.room_id IS NOT NULL
        AND s.deleted_at IS NOT NULL AND s.purged_at IS NULL
        AND s.deleted_at <= clock_timestamp() - ${TRASH_RETENTION_INTERVAL_SQL}
      FOR UPDATE`,
    [spaceId, sessionId],
  );
  if (!locked.rowCount) return "skipped";
  const scope = [spaceId, sessionId];

  await db.query(
    `UPDATE sessions SET head_message_id = NULL, title = NULL, purged_at = now(), updated_at = now()
      WHERE space_id = $1 AND id = $2`,
    scope,
  );
  await db.query("DELETE FROM room_queued_messages WHERE space_id = $1 AND session_id = $2", scope);
  await db.query("DELETE FROM conversation_folder_access_grants WHERE space_id = $1 AND session_id = $2", scope);
  await db.query("DELETE FROM message_input_parts WHERE space_id = $1 AND session_id = $2", scope);
  await db.query("DELETE FROM conversation_file_snapshots WHERE space_id = $1 AND session_id = $2", scope);
  // Shared resource blobs stay; the existing unreferenced-blob sweep reclaims
  // any that no other conversation still uses.
  await db.query("DELETE FROM conversation_input_resources WHERE space_id = $1 AND session_id = $2", scope);
  // Uploaded media files are unlinked by the existing media retention sweep.
  await db.query(
    `UPDATE conversation_input_media media SET lifecycle = 'deleted', message_id = NULL
      WHERE media.space_id = $1
        AND media.message_id IN (SELECT m.id FROM messages m WHERE m.space_id = $1 AND m.session_id = $2)`,
    scope,
  );
  // A discussion a retained Run group points at is kept, without its topic.
  await db.query(
    `DELETE FROM room_discussions d
      WHERE d.space_id = $1 AND d.session_id = $2
        AND NOT EXISTS (SELECT 1 FROM agent_run_groups g WHERE g.space_id = d.space_id AND g.discussion_id = d.id)`,
    scope,
  );
  await db.query("UPDATE room_discussions SET topic = NULL WHERE space_id = $1 AND session_id = $2", scope);
  // Retained records name the message they started from
  // (`MESSAGE_ANCHOR_REFERENCES`), and a message names its parent. Those
  // anchors and their ancestors stay as empty rows; every other message goes.
  const anchors = MESSAGE_ANCHOR_REFERENCES.map(({ table, column, session }) =>
    `SELECT r.${column} AS id FROM ${table} r
      WHERE r.space_id = $1 AND r.${session} = $2 AND r.${column} IS NOT NULL`).join("\n         UNION\n         ");
  await db.query(
    `WITH RECURSIVE anchor(id) AS (
       SELECT seed.id FROM (
         ${anchors}
       ) seed
       UNION
       SELECT m.parent_message_id FROM messages m JOIN anchor a ON a.id = m.id
        WHERE m.space_id = $1 AND m.session_id = $2 AND m.parent_message_id IS NOT NULL
     )
     DELETE FROM messages m
      WHERE m.space_id = $1 AND m.session_id = $2
        AND NOT EXISTS (SELECT 1 FROM anchor WHERE anchor.id = m.id)`,
    scope,
  );
  await db.query(
    "UPDATE messages SET content = '', metadata_json = NULL WHERE space_id = $1 AND session_id = $2",
    scope,
  );

  if (await hasProtectedReference(db, spaceId, sessionId)) return "tombstoned";
  // A reference this list does not know yet keeps the tombstone rather than
  // failing the purge: the foreign key, not this module, is the authority.
  await db.query("SAVEPOINT room_conversation_purge");
  try {
    await db.query("DELETE FROM sessions WHERE space_id = $1 AND id = $2", scope);
    await db.query("RELEASE SAVEPOINT room_conversation_purge");
    return "removed";
  } catch (error) {
    if ((error as { code?: string }).code !== "23503") throw error;
    await db.query("ROLLBACK TO SAVEPOINT room_conversation_purge");
    return "tombstoned";
  }
}

async function hasProtectedReference(db: Queryable, spaceId: string, sessionId: string): Promise<boolean> {
  // A message kept as an anchor still belongs to this conversation.
  const probes = [...PROTECTED_SESSION_REFERENCES, "messages"].map((table) =>
    `EXISTS (SELECT 1 FROM ${table} WHERE space_id = $1 AND session_id = $2)`);
  const result = await db.query<{ referenced: boolean }>(`SELECT (${probes.join(" OR ")}) AS referenced`, [spaceId, sessionId]);
  return Boolean(result.rows[0]?.referenced);
}
