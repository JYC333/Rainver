import { randomUUID } from "node:crypto";
import type { QueuedRoomMessage } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Pool, PoolClient } from "../../db/pool.js";
import { HttpError, withDbTransaction, type Queryable } from "../routeUtils/common.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { canWriteProject } from "../projects/access.js";
import { isConversationTurnInProgressError } from "../sessions/conversationRuntimeSessionRepository.js";
import { PgRoomDiscussionRepository } from "./discussionRepository.js";
import type { AgentGroupMessageRecipientSegment } from "../agentGroups/service.js";
import { PgRoomRepository } from "./repository.js";
import { RoomService, type RoomIdentity } from "./service.js";

/**
 * A person's message sent while the conversation's turn is taken waits for
 * the next turn boundary instead of being refused.
 *
 * It waits in `room_queued_messages`, outside the message tree: nothing that
 * reads the conversation — a prompt, a replay, a summary — sees it, and it
 * takes its place in the timeline only when it is posted, as an ordinary
 * message, the moment the conversation's last running turn has completed.
 * Inside a discussion that is between waves, ahead of the next wave the
 * Agents' replies asked for, in the same transaction as that advance: the
 * person's message joins the discussion as a new first round — the round cap
 * counts again from it, the spend cap does not — and the Agents it held back
 * follow it (`discussionService.ts`). A message that cannot be posted stays
 * visible to its sender as failed, with the reason, until they dismiss it.
 * Every queued message also has a release job behind it, so one survives a
 * restart between a turn's completion and its release.
 */
interface QueuedRow {
  id: string;
  space_id: string;
  room_id: string;
  session_id: string;
  user_id: string;
  content: string;
  request_json: unknown;
  status: QueuedRoomMessage["status"];
  released_message_id: string | null;
  failure_reason: string | null;
  created_at: unknown;
}

/** The send request a queued message is posted with, exactly as it was made. */
export interface QueuedSendRequest {
  routing_mode: "direct" | "agent_coordination";
  recipient_segments: AgentGroupMessageRecipientSegment[] | null;
  focus_refs: Array<{ type: "task"; id: string }> | null;
  backends: Array<{ agent_id: string; runtime_profile_id: string; session_config?: unknown[] }>;
}

export const ROOM_QUEUED_MESSAGE_RELEASE_JOB = "room_queued_message_release";
const RELEASE_JOB_DELAY_MS = 5_000;

const COLUMNS = `id, space_id, room_id, session_id, user_id, content, request_json, status,
  released_message_id, failure_reason, created_at`;

export async function enqueueRoomMessage(
  db: Queryable,
  input: { spaceId: string; roomId: string; sessionId: string; userId: string; content: string; request: QueuedSendRequest },
): Promise<QueuedRoomMessage> {
  const now = new Date().toISOString();
  const result = await db.query<QueuedRow>(
    `INSERT INTO room_queued_messages (id, space_id, room_id, session_id, user_id, content, request_json, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'queued',$8,$8)
     RETURNING ${COLUMNS}`,
    [randomUUID(), input.spaceId, input.roomId, input.sessionId, input.userId, input.content, JSON.stringify(input.request), now],
  );
  await new PgJobQueueRepository(db).enqueue({
    job_type: ROOM_QUEUED_MESSAGE_RELEASE_JOB,
    space_id: input.spaceId,
    user_id: null,
    payload: { session_id: input.sessionId },
    scheduled_at: new Date(Date.now() + RELEASE_JOB_DELAY_MS),
  });
  return queuedOut(result.rows[0]!);
}

/** Serializes a conversation's queue with its discussion's advances and with sends that may queue. */
export async function lockRoomConversationQueue(db: Queryable, spaceId: string, sessionId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`room-discussion:${spaceId}:${sessionId}`]);
}

export async function hasQueuedRoomMessage(db: Queryable, spaceId: string, sessionId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM room_queued_messages WHERE space_id = $1 AND session_id = $2 AND status = 'queued' LIMIT 1`,
    [spaceId, sessionId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * What waits in a conversation, oldest first — shown to every member, since
 * it is what someone said — and, to its sender only, what could not be
 * posted and they have not dismissed.
 */
export async function listQueuedRoomMessages(db: Queryable, spaceId: string, sessionId: string, viewerUserId: string): Promise<QueuedRoomMessage[]> {
  const result = await db.query<QueuedRow>(
    `SELECT ${COLUMNS} FROM room_queued_messages
      WHERE space_id = $1 AND session_id = $2
        AND (status = 'queued' OR (status = 'failed' AND user_id = $3))
      ORDER BY created_at, id`,
    [spaceId, sessionId, viewerUserId],
  );
  return result.rows.map(queuedOut);
}

export class RoomMessageQueue {
  constructor(
    private readonly config: ServerConfig,
    private readonly pool: Pool,
  ) {}

  /** Take back a message that has not been posted yet, or dismiss one that failed. Only its sender may. */
  async withdraw(identity: RoomIdentity, roomId: string, sessionId: string, queuedId: string): Promise<QueuedRoomMessage> {
    return withDbTransaction(this.pool, async (client) => {
      const room = await new PgRoomRepository(client).getVisibleRoom(identity.spaceId, identity.userId, roomId, false);
      if (!room) throw new HttpError(404, "Room not found in this space");
      const result = await client.query<QueuedRow>(
        `UPDATE room_queued_messages SET status = 'withdrawn', updated_at = now()
          WHERE space_id = $1 AND room_id = $2 AND session_id = $3 AND id = $4
            AND user_id = $5 AND status IN ('queued', 'failed')
          RETURNING ${COLUMNS}`,
        [identity.spaceId, roomId, sessionId, queuedId, identity.userId],
      );
      if (!result.rows[0]) throw new HttpError(404, "No waiting or failed message of yours with that id in this conversation");
      return queuedOut(result.rows[0]);
    });
  }

  /**
   * Post the oldest waiting message now that the conversation's turn is
   * free. The caller holds `lockRoomConversationQueue`. It joins a running
   * discussion (`joinDiscussion`, the default) unless it goes ahead of a
   * wave that is waiting rather than done. A turn still taken
   * leaves it waiting; a message that cannot be posted for any other reason
   * is marked failed with the reason and the next one is tried, so it never
   * blocks the ones behind it.
   */
  async releaseNext(
    client: PoolClient,
    spaceId: string,
    sessionId: string,
    options: { joinDiscussion?: boolean } = {},
  ): Promise<"released" | "busy" | "empty"> {
    for (;;) {
      const next = (await client.query<QueuedRow>(
        `SELECT ${COLUMNS} FROM room_queued_messages
          WHERE space_id = $1 AND session_id = $2 AND status = 'queued'
          ORDER BY created_at, id
          LIMIT 1
          FOR UPDATE`,
        [spaceId, sessionId],
      )).rows[0];
      if (!next) return "empty";
      await client.query("SAVEPOINT release_queued_message");
      try {
        const posted = await this.post(client, next, options.joinDiscussion ?? true);
        await client.query("RELEASE SAVEPOINT release_queued_message");
        await client.query(
          `UPDATE room_queued_messages SET status = 'released', released_message_id = $2, updated_at = now() WHERE id = $1`,
          [next.id, posted],
        );
        return "released";
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT release_queued_message");
        await client.query("RELEASE SAVEPOINT release_queued_message");
        if (isTurnTaken(error) || isTransientDatabaseError(error)) return "busy";
        // What the sender is shown: a refusal's own words, never an internal error's.
        await client.query(
          `UPDATE room_queued_messages SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
          [next.id, error instanceof HttpError ? error.message : "The message could not be posted."],
        );
      }
    }
  }

  private async post(client: PoolClient, queued: QueuedRow, joinDiscussion: boolean): Promise<string> {
    const request = queued.request_json as QueuedSendRequest;
    const identity = { spaceId: queued.space_id, userId: queued.user_id };
    const dispatched = await new RoomService(this.config, this.pool).sendMessageInTransaction(
      client,
      identity,
      queued.room_id,
      queued.session_id,
      {
        content: queued.content,
        recipient_segments: request.recipient_segments ?? null,
        routing_mode: request.routing_mode ?? "direct",
        focus_refs: request.focus_refs ?? null,
        backends: request.backends as never ?? [],
      },
    );
    // A running discussion takes the person's message as its next round.
    // From a Project writer — who may open and extend discussions — it is a
    // new first round, and a new decision to spend: what follows runs for
    // them (B8A), within the spend cap already set. Anyone else's message is
    // one more round within the bound the discussion already has.
    const discussions = new PgRoomDiscussionRepository(client);
    const discussion = await discussions.getOpenForSession(queued.space_id, queued.session_id, { forUpdate: true });
    if (joinDiscussion && discussion?.status === "active") {
      const wave = discussion.rounds_used;
      const room = await new PgRoomRepository(client).getVisibleRoom(queued.space_id, queued.user_id, queued.room_id, false);
      const restarts = room !== null && await canWriteProject(client, queued.space_id, room.project_id, queued.user_id);
      if (restarts && discussion.opened_by_user_id !== queued.user_id) {
        await client.query(
          `UPDATE room_discussions
              SET opened_by_user_id = $3, quota_override_by_user_id = NULL, quota_override_at = NULL
            WHERE space_id = $1 AND id = $2`,
          [queued.space_id, discussion.id, queued.user_id],
        );
      }
      await discussions.stampGroup(queued.space_id, dispatched.task_group_ids[0]!, discussion.id);
      await discussions.stampMessages({
        spaceId: queued.space_id, sessionId: queued.session_id, discussionId: discussion.id, wave,
        messageIds: [dispatched.message.id],
      });
      await discussions.update(queued.space_id, discussion.id, { ...(restarts ? { roundBase: wave } : {}), roundsUsed: wave + 1 });
    }
    return dispatched.message.id;
  }
}

/**
 * A failure that says nothing about what is being done: a deadlock, a
 * serialization conflict, a statement timeout, a lost connection. Retried,
 * never taken as the outcome.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
  return typeof code === "string" && (
    code === "40P01" || code === "40001" || code === "57014" || code === "57P01"
    || code.startsWith("08") || code.startsWith("53")
  );
}

/**
 * The conversation's turn is taken, or one addressed Agent's host thread is
 * still on the turn that just ended: either way the message waits rather
 * than fails.
 */
/**
 * Whether posting into the conversation failed only for now: its turn, or an
 * addressed Agent's host thread, is taken, or the database failed transiently.
 * A continuation that meets one is retried, never dropped.
 */
export function isRetryableRoomPostError(error: unknown): boolean {
  return isConversationTurnInProgressError(error) || isTurnTaken(error) || isTransientDatabaseError(error);
}

export function isTurnTaken(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.statusCode !== 409) return false;
  const code = error.responseBody && typeof error.responseBody === "object"
    ? (error.responseBody as { code?: unknown }).code
    : undefined;
  return code === "conversation_turn_in_progress" || code === "room_agent_turn_in_progress";
}

function queuedOut(row: QueuedRow): QueuedRoomMessage {
  return {
    id: row.id,
    room_id: row.room_id,
    session_id: row.session_id,
    user_id: row.user_id,
    content: row.content,
    status: row.status,
    released_message_id: row.released_message_id,
    failure_reason: row.failure_reason,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
