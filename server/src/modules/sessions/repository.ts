import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import {
  MessageMetadataSchema,
  type InternalMessageMetadata,
  type MessageMetadata,
  type SystemNoticeMessageMetadata,
  type MessageOut,
  type SessionOut,
  type SessionPage,
} from "@rainver/protocol";
import { projectReadAccessSql } from "../access/contentAccessSql.js";
import { ROOT_BRANCH_PATH, visibleMessagePathSql } from "./messagePath.js";

export interface CreateSessionInput {
  projectFolderId?: string | null;
  projectId?:string|null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AddMessageInput {
  role: string;
  content: string;
  metadata?: MessageMetadata | null;
  /**
   * Overrides the wall clock. Every ordering in the system is
   * `(created_at, id)` and `created_at` is millisecond precision, so two
   * messages written in one transaction can collide and fall back to a random
   * UUID. A caller writing several in sequence — references and then the
   * message that carried them — stamps them explicitly so the order it
   * intends is the order that is stored.
   */
  created_at?: string;
  /** The Run this message belongs to, when the caller already knows it. */
  run_id?: string | null;
}

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface SessionRow {
  id: string;
  space_id: string;
  user_id: string | null;
  project_folder_id: string | null;
  project_id:string|null;
  room_id: string | null;
  title: string | null;
  status: string;
  created_at: unknown;
  updated_at: unknown;
}

interface MessageRow {
  id: string;
  session_id: string;
  space_id: string;
  user_id: string | null;
  sender_agent_id: string | null;
  role: string;
  content: string;
  metadata_json: unknown;
  parent_message_id: string | null;
  run_id: string | null;
  created_at: unknown;
}


/**
 * Server repository for the public `sessions` command surface. A session/message is
 * only visible to its owning user inside its own space, and only
 * `status = 'active'` non-Room sessions are listed. Room conversations have
 * their own explicit methods so public Session commands cannot bypass Room
 * dispatch or authorization.
 *
 * Owns list/get/create sessions plus list/add messages.
 * Session `reflect` creates proposal-first memory candidates in the server.
 */
export class PgSessionRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgSessionRepository {
    if (!config.databaseUrl) {
      throw new Error("Session repository requires SERVER_DATABASE_URL");
    }
    return new PgSessionRepository(getDbPool(config.databaseUrl));
  }

  async listSessions(
    spaceId: string,
    userId: string,
    limit: number,
    offset: number,
  ): Promise<SessionPage> {
    const totalResult = await this.db.query<{ total: string | number }>(
      `SELECT count(s.id)::text AS total
         FROM sessions s
        WHERE s.space_id = $1
          AND s.user_id = $2
          AND s.room_id IS NULL
          AND (
            s.project_id IS NULL
            OR ${projectReadAccessSql("s.space_id", "s.project_id", "$2")}
          )
          AND s.status = 'active'`,
      [spaceId, userId],
    );
    const rowsResult = await this.db.query<SessionRow>(
      `${sessionSelectSql()}
        WHERE s.space_id = $1
          AND s.user_id = $2
          AND s.room_id IS NULL
          AND (
            s.project_id IS NULL
            OR ${projectReadAccessSql("s.space_id", "s.project_id", "$2")}
          )
          AND s.status = 'active'
        ORDER BY s.updated_at DESC
        LIMIT $3 OFFSET $4`,
      [spaceId, userId, limit, offset],
    );
    return {
      items: rowsResult.rows.map(sessionToOut),
      total: numberValue(totalResult.rows[0]?.total) ?? 0,
      limit,
      offset,
    };
  }

  async getSession(
    spaceId: string,
    userId: string,
    sessionId: string,
  ): Promise<SessionOut | null> {
    const result = await this.db.query<SessionRow>(
      `${sessionSelectSql()}
        WHERE s.id = $1
          AND s.space_id = $2
          AND s.user_id = $3
          AND s.room_id IS NULL
          AND (
            s.project_id IS NULL
            OR ${projectReadAccessSql("s.space_id", "s.project_id", "$3")}
          )
          AND s.status = 'active'`,
      [sessionId, spaceId, userId],
    );
    const row = result.rows[0];
    return row ? sessionToOut(row) : null;
  }

  async getRoomConversation(
    spaceId: string,
    userId: string,
    sessionId: string,
    roomId?: string | null,
  ): Promise<SessionOut | null> {
    const result = await this.db.query<SessionRow>(
      `${sessionSelectSql()}
        JOIN rooms room
          ON room.id = s.room_id
         AND room.space_id = s.space_id
         AND room.project_id = s.project_id
         AND room.status = 'active'
        JOIN room_user_members room_member
          ON room_member.room_id = room.id
         AND room_member.space_id = room.space_id
         AND room_member.user_id = $3
         AND room_member.status = 'active'
        WHERE s.id = $1
          AND s.space_id = $2
          AND s.room_id IS NOT NULL
          AND ($4::varchar IS NULL OR s.room_id = $4)
          AND ${projectReadAccessSql("s.space_id", "s.project_id", "$3")}
          AND s.status = 'active'`,
      [sessionId, spaceId, userId, roomId ?? null],
    );
    const row = result.rows[0];
    return row ? sessionToOut(row) : null;
  }

  async getConversationForBackendSelection(
    spaceId: string,
    userId: string,
    sessionId: string,
  ): Promise<SessionOut | null> {
    return await this.getSession(spaceId, userId, sessionId)
      ?? this.getRoomConversation(spaceId, userId, sessionId);
  }

  async listMessages(
    spaceId: string,
    userId: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): Promise<MessageOut[] | null> {
    // 404 (null) when the session is not visible to this user in
    // this space, even if message rows exist.
    const session = await this.getSession(spaceId, userId, sessionId);
    if (!session) return null;
    return this.loadMessagePage(spaceId, sessionId, limit, offset);
  }

  private async loadMessagePage(
    spaceId: string,
    sessionId: string,
    limit: number,
    offset: number,
    visibleRoomTranscriptOnly = false,
    /** One message by id, through this same projection rather than a second one. */
    messageId: string | null = null,
  ): Promise<MessageOut[]> {
    const result = await this.db.query<MessageRow>(
      // Newest-first with LIMIT/OFFSET selects the window, then the outer
      // query returns it in transcript order. `path` restricts both to the
      // conversation's visible branch.
      // Newest-first with LIMIT/OFFSET selects the window, then the outer
      // query returns it in transcript order. Ordering is by `path_depth`,
      // which is the conversation's own order — `created_at` would order two
      // branches by when each was written rather than by where each sits.
      `SELECT *
         FROM (
           SELECT m.id,
                  m.session_id,
                  m.space_id,
                  m.user_id,
                  m.sender_agent_id,
                  m.role,
                  m.content,
                  m.metadata_json,
                  m.parent_message_id,
                  m.run_id,
                  m.path_depth,
                  m.created_at
             FROM messages m
            WHERE m.session_id = $1
              AND m.space_id = $2
              AND ${visibleMessagePathSql({ alias: "m", spaceParam: "$2", sessionParam: "$1" })}
              AND ($5::boolean = false OR COALESCE(m.metadata_json->>'room_display', 'conversation') <> 'internal')
              AND ($6::varchar IS NULL OR m.id = $6)
            ORDER BY m.path_depth DESC, m.id DESC
            LIMIT $3 OFFSET $4
         ) message_page
        ORDER BY message_page.path_depth ASC, message_page.id ASC`,
      [sessionId, spaceId, limit, offset, visibleRoomTranscriptOnly, messageId],
    );
    return result.rows.map(messageToOut);
  }

  async listRoomMessages(
    spaceId: string,
    userId: string,
    roomId: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): Promise<MessageOut[] | null> {
    const session = await this.getRoomConversation(
      spaceId,
      userId,
      sessionId,
      roomId,
    );
    if (!session) return null;
    return this.loadMessagePage(spaceId, sessionId, limit, offset, true);
  }

  /**
   * One Room message by id, gated and projected exactly as the page is.
   *
   * For a caller that already knows which message it wants. An idempotent
   * replay names a thread's *first* message, which falls out of any
   * recent-page window as soon as the thread grows past it.
   */
  async roomMessageById(
    spaceId: string,
    userId: string,
    roomId: string,
    sessionId: string,
    messageId: string,
  ): Promise<MessageOut | null> {
    const session = await this.getRoomConversation(spaceId, userId, sessionId, roomId);
    if (!session) return null;
    const page = await this.loadMessagePage(spaceId, sessionId, 1, 0, true, messageId);
    return page[0] ?? null;
  }

  /**
   * Named messages of one conversation, in transcript order.
   *
   * For a caller that already holds the conversation and has decided the
   * viewer may read it; this only fetches what they named. Internal
   * instructions are excluded, as they are from the transcript: the pick
   * surface must not be wider than what the person can read.
   */
  async roomMessagesByIds(
    spaceId: string,
    sessionId: string,
    ids: readonly string[],
  ): Promise<Array<{ id: string; role: string; content: string; created_at: string }>> {
    const result = await this.db.query<{ id: string; role: string; content: string; created_at: string }>(
      `SELECT m.id, m.role, m.content, m.created_at
         FROM messages m
        WHERE m.space_id = $1 AND m.session_id = $2 AND m.id = ANY($3::varchar[])
          AND ${visibleMessagePathSql({ alias: "m", spaceParam: "$1", sessionParam: "$2" })}
          AND COALESCE(m.metadata_json->>'room_display', '') <> 'internal'
        ORDER BY m.path_depth ASC, m.id ASC`,
      [spaceId, sessionId, [...ids]],
    );
    return result.rows;
  }

  async listRecentMessagesForContext(
    spaceId: string,
    userId: string,
    sessionId: string,
    limit: number,
  ): Promise<MessageOut[] | null> {
    const session = await this.getSession(spaceId, userId, sessionId);
    if (!session) return null;
    const result = await this.db.query<MessageRow>(
      // The `id` tiebreak makes the newest-N selection and chronological return
      // deterministic on equal timestamps and across concurrent readers.
      `SELECT *
         FROM (
           SELECT m.id,
                  m.session_id,
                  m.space_id,
                  m.user_id,
                  m.sender_agent_id,
                  m.role,
                  m.content,
                  m.metadata_json,
                  m.parent_message_id,
                  m.run_id,
                  m.path_depth,
                  m.created_at
             FROM messages m
            WHERE m.session_id = $1
              AND m.space_id = $2
              AND ${visibleMessagePathSql({ alias: "m", spaceParam: "$2", sessionParam: "$1" })}
            ORDER BY m.path_depth DESC, m.id DESC
            LIMIT $3
         ) recent
        ORDER BY recent.path_depth ASC, recent.id ASC`,
      [sessionId, spaceId, clampLimit(limit)],
    );
    return result.rows.map(messageToOut);
  }

  async createSession(
    spaceId: string,
    userId: string,
    input: CreateSessionInput,
  ): Promise<SessionOut> {
    // `sessions` has no server-side defaults for id/status/timestamps, so this
    // supplies them explicitly or the INSERT violates NOT NULL:
    // status='active', agent_id left null, created_at == updated_at.
    const now = new Date().toISOString();
    const result = await this.db.query<SessionRow>(
      `INSERT INTO sessions
         (id, space_id, user_id, project_folder_id, project_id, room_id, title, status, metadata_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, 'active', $7::jsonb, $8, $8)
       RETURNING id, space_id, user_id, project_folder_id, project_id, room_id, title, status, created_at, updated_at`,
      [
        randomUUID(),
        spaceId,
        userId,
        input.projectFolderId ?? null,
        input.projectId??null,
        input.title ?? null,
        sessionMetadataParam(input.metadata),
        now,
      ],
    );
    return sessionToOut(result.rows[0]!);
  }

  async createRoomConversation(input: {
    space_id: string;
    room_id: string;
    project_id: string;
    project_folder_id?: string | null;
    title?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<SessionOut> {
    const now = new Date().toISOString();
    const result = await this.db.query<SessionRow>(
      `INSERT INTO sessions (
         id, space_id, user_id, agent_id, project_folder_id, project_id,
         room_id, title, status, metadata_json, created_at, updated_at
       ) VALUES (
         $1, $2, NULL, NULL, $3, $4, $5, $6, 'active', $7::jsonb, $8, $8
       )
       RETURNING id, space_id, user_id, project_folder_id, project_id, room_id,
                 title, status, created_at, updated_at`,
      [
        randomUUID(),
        input.space_id,
        input.project_folder_id ?? null,
        input.project_id,
        input.room_id,
        input.title ?? null,
        sessionMetadataParam(input.metadata),
        now,
      ],
    );
    return sessionToOut(result.rows[0]!);
  }

  async findOpenRoomDraft(input: {
    space_id: string;
    room_id: string;
  }): Promise<SessionOut | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT s.id, s.space_id, s.user_id, s.project_folder_id, s.project_id,
              s.room_id, s.title, s.status, s.created_at, s.updated_at
         FROM sessions s
        WHERE s.space_id = $1
          AND s.room_id = $2
          AND s.status = 'active'
          AND s.metadata_json->>'execution_setup_started' = 'true'
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.space_id = s.space_id AND m.session_id = s.id
          )
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 1
        FOR UPDATE`,
      [input.space_id, input.room_id],
    );
    return result.rows[0] ? sessionToOut(result.rows[0]) : null;
  }

  async addMessage(
    spaceId: string,
    userId: string,
    sessionId: string,
    input: AddMessageInput,
  ): Promise<MessageOut | null> {
    // Only the owning user in the owning space may append; a missing/invisible
    // session is 404 (null), not an error.
    const session = await this.getSession(spaceId, userId, sessionId);
    if (!session) return null;
    return this.insertAttributedMessage(spaceId, userId, sessionId, input);
  }

  async attachRunToUserMessage(input: {
    space_id: string;
    user_id: string;
    session_id: string;
    message_id: string;
    run_id: string;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE messages
          SET run_id = $5
        WHERE id = $4
          AND space_id = $1
          AND session_id = $3
          AND user_id = $2
          AND role = 'user'`,
      [
        input.space_id,
        input.user_id,
        input.session_id,
        input.message_id,
        input.run_id,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async addRoomUserMessage(
    spaceId: string,
    userId: string,
    roomId: string,
    sessionId: string,
    input: Omit<AddMessageInput, "role">,
  ): Promise<MessageOut | null> {
    const session = await this.getRoomConversation(
      spaceId,
      userId,
      sessionId,
      roomId,
    );
    if (!session) return null;
    return this.insertAttributedMessage(spaceId, userId, sessionId, {
      ...input,
      role: "user",
    });
  }

  async addRoomInternalInstruction(
    spaceId: string,
    userId: string,
    roomId: string,
    sessionId: string,
    input: Omit<AddMessageInput, "role" | "metadata"> & {
      metadata?: Omit<InternalMessageMetadata, "room_display"> | null;
    },
  ): Promise<MessageOut | null> {
    const session = await this.getRoomConversation(
      spaceId,
      userId,
      sessionId,
      roomId,
    );
    if (!session) return null;
    return this.insertAttributedMessage(spaceId, userId, sessionId, {
      ...input,
      role: "system",
      metadata: {
        ...(input.metadata ?? {}),
        room_display: "internal",
        continuation: true,
        continuation_requested_by_user_id: userId,
      },
    }, null);
  }

  /** A visible Room system notice, distinct from hidden execution instructions. */
  async addRoomSystemNotice(
    spaceId: string,
    userId: string,
    roomId: string,
    sessionId: string,
    input: Omit<AddMessageInput, "role" | "metadata"> & {
      metadata?: Omit<SystemNoticeMessageMetadata, "room_display"> | null;
    },
  ): Promise<MessageOut | null> {
    const session = await this.getRoomConversation(spaceId, userId, sessionId, roomId);
    if (!session) return null;
    return this.insertAttributedMessage(spaceId, userId, sessionId, {
      ...input,
      role: "system",
      metadata: {
        ...(input.metadata ?? {}),
        room_display: "system_notice",
      },
    }, null);
  }

  /**
   * A durable, visible execution-context event for either a direct or Room
   * Conversation. The visibility check deliberately reuses the same
   * conversation projection as the read routes, and the event key makes a
   * retried initialization/access mutation idempotent.
   */
  async addExecutionSystemEvent(
    spaceId: string,
    userId: string,
    sessionId: string,
    input: {
      event: string;
      eventKey: string;
      content: string;
      details: Record<string, unknown>;
    },
  ): Promise<MessageOut | null> {
    const session = await this.getConversationForBackendSelection(spaceId, userId, sessionId);
    if (!session) return null;
    const existing = await this.db.query<MessageRow>(
      `SELECT id, session_id, space_id, user_id, sender_agent_id, role,
              content, metadata_json, parent_message_id, run_id, created_at
         FROM messages
        WHERE space_id = $1 AND session_id = $2 AND role = 'system'
          AND metadata_json->>'room_display' = 'system_notice'
          AND metadata_json->>'execution_event' = $3
          AND metadata_json->>'execution_event_key' = $4
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [spaceId, sessionId, input.event, input.eventKey],
    );
    if (existing.rows[0]) return messageToOut(existing.rows[0]);
    return this.insertAttributedMessage(spaceId, userId, sessionId, {
      role: "system",
      content: input.content,
      metadata: {
        room_display: "system_notice",
        execution_event: input.event,
        execution_event_key: input.eventKey,
        execution_details: input.details,
      },
    });
  }

  /** Locate a previously committed execution mutation by its client-stable key. */
  async findExecutionSystemEvent(
    spaceId: string,
    userId: string,
    sessionId: string,
    eventKey: string,
  ): Promise<{ attachment_id: string; effective_after_run_id: string | null } | null> {
    const session = await this.getConversationForBackendSelection(spaceId, userId, sessionId);
    if (!session) return null;
    const result = await this.db.query<{ metadata_json: unknown }>(
      `SELECT metadata_json
         FROM messages
        WHERE space_id = $1 AND session_id = $2 AND role = 'system'
          AND metadata_json->>'room_display' = 'system_notice'
          AND metadata_json->>'execution_event' LIKE 'execution_attachment_%'
          AND metadata_json->>'execution_event_key' = $3
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [spaceId, sessionId, eventKey],
    );
    const metadata = result.rows[0]?.metadata_json;
    if (!metadata || typeof metadata !== "object") return null;
    const details = (metadata as Record<string, unknown>).execution_details;
    if (!details || typeof details !== "object") return null;
    const attachmentId = (details as Record<string, unknown>).attachment_id;
    const effectiveAfterRunId = (details as Record<string, unknown>).effective_after_run_id;
    if (typeof attachmentId !== "string") return null;
    return {
      attachment_id: attachmentId,
      effective_after_run_id: typeof effectiveAfterRunId === "string" ? effectiveAfterRunId : null,
    };
  }

  /**
   * Content copied in from elsewhere, as a message in this conversation.
   *
   * System role, like an internal instruction: it is execution context and
   * transcript, but it is not somebody speaking. That distinction is load
   * bearing — the checkpoint extractor derives `confirmed` from `role='user'`
   * alone, so a reference can never be read as the person having agreed to
   * what it contains.
   *
   * `user_id` is stored so the transcript can say who attached it; the
   * provenance block says where it came from and how far to trust it.
   */
  async addRoomReference(
    spaceId: string,
    userId: string,
    roomId: string,
    sessionId: string,
    input: { content: string; provenance: Record<string, unknown>; created_at?: string },
  ): Promise<MessageOut | null> {
    const session = await this.getRoomConversation(spaceId, userId, sessionId, roomId);
    if (!session) return null;
    return this.insertAttributedMessage(spaceId, userId, sessionId, {
      content: input.content,
      role: "system",
      created_at: input.created_at,
      metadata: {
        room_display: "reference",
        reference: input.provenance,
      },
    });
  }

  async findRoomProposalContinuation(
    spaceId: string,
    userId: string,
    roomId: string,
    sessionId: string,
    proposalId: string,
  ): Promise<MessageOut | null> {
    const session = await this.getRoomConversation(spaceId, userId, sessionId, roomId);
    if (!session) return null;
    const result = await this.db.query<MessageRow>(
      `SELECT id, session_id, space_id, user_id, sender_agent_id, role,
              content, metadata_json, parent_message_id, run_id, created_at
         FROM messages
        WHERE space_id = $1 AND session_id = $2 AND role = 'system'
          AND metadata_json->>'room_display' = 'internal'
          AND metadata_json->>'continuation_proposal_id' = $3
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [spaceId, sessionId, proposalId],
    );
    return result.rows[0] ? messageToOut(result.rows[0]) : null;
  }

  /** The event-triggered sibling of `findRoomProposalContinuation` (plan
   * Phase 3): dedupes a domain-completion continuation by (event kind,
   * event key) instead of a Proposal id. */
  async findRoomEventContinuation(
    spaceId: string,
    userId: string,
    roomId: string,
    sessionId: string,
    eventKind: string,
    eventKey: string,
  ): Promise<MessageOut | null> {
    const session = await this.getRoomConversation(spaceId, userId, sessionId, roomId);
    if (!session) return null;
    const result = await this.db.query<MessageRow>(
      `SELECT id, session_id, space_id, user_id, sender_agent_id, role,
              content, metadata_json, parent_message_id, run_id, created_at
         FROM messages
        WHERE space_id = $1 AND session_id = $2 AND role = 'system'
          AND metadata_json->>'room_display' = 'internal'
          AND metadata_json->>'continuation_event_kind' = $3
          AND metadata_json->>'continuation_event_key' = $4
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [spaceId, sessionId, eventKind, eventKey],
    );
    return result.rows[0] ? messageToOut(result.rows[0]) : null;
  }

  /**
   * Takes the conversation's append lock, in a statement of its own.
   *
   * The lock has to be a separate statement, not a CTE inside the insert.
   * Under READ COMMITTED a statement's snapshot is taken before it starts
   * waiting on a lock, so an insert that locks and reads the head in one
   * statement reads the head as it was *before* it waited — the other
   * writer's message is invisible and the new row lands on a position that is
   * already taken.
   *
   * This only holds the lock when the caller gave us a client inside their
   * transaction; on a pool each statement is its own transaction and the lock
   * is released as this one ends. That split is deliberate, because the two
   * cases need opposite things:
   *
   * - **Inside a transaction** a collision is unrecoverable — the failed
   *   statement poisons the transaction, so every retry returns 25P02 and the
   *   caller's whole unit of work is lost. The lock has to *prevent* it, and
   *   here it does: measured 16 concurrent transactional appends completing
   *   with zero retries and no duplicate position.
   * - **On a pool** this lock does nothing: each statement is its own
   *   transaction, so it is released before the insert runs. Nothing is
   *   poisoned there either, so `uq_messages_branch_position` plus
   *   `withBranchPositionRetry` handle the collision, as they did before this
   *   lock existed. The extra round trip buys nothing on that path and is
   *   kept only because the method cannot tell which kind of client it has.
   */
  private async lockConversationForAppend(spaceId: string, sessionId: string): Promise<boolean> {
    const locked = await this.db.query(
      `SELECT 1 FROM sessions WHERE id = $1 AND space_id = $2 FOR UPDATE`,
      [sessionId, spaceId],
    );
    return (locked.rowCount ?? 0) > 0;
  }

  private async insertAttributedMessage(
    spaceId: string,
    userId: string,
    sessionId: string,
    input: AddMessageInput,
    storedUserId: string | null = userId,
  ): Promise<MessageOut> {
    const now = input.created_at ?? new Date().toISOString();
    // The append lock is taken first, in its own statement, so this insert's
    // snapshot includes the message a concurrent writer may just have
    // committed — see `lockConversationForAppend`.
    await this.lockConversationForAppend(spaceId, sessionId);
    // Atomic: insert the message and touch the session's updated_at in one
    // statement (data-modifying CTEs run to completion regardless of the final
    // SELECT).
    const result = await withBranchPositionRetry(() => this.db.query<MessageRow>(
      `WITH locked AS (
         SELECT session_row.id, session_row.head_message_id
           FROM sessions session_row
          WHERE session_row.id = $3 AND session_row.space_id = $2
          FOR UPDATE
       ), inserted AS (
         INSERT INTO messages
           (id, space_id, session_id, user_id, sender_agent_id, role, content, metadata_json,
            parent_message_id, run_id, path_depth, branch_path, created_at)
         SELECT $1, $2, $3, $4, NULL, $5, $6, $7::jsonb,
                locked.head_message_id, $9,
                COALESCE((SELECT head.path_depth + 1 FROM messages head
                           WHERE head.id = locked.head_message_id
                             AND head.space_id = $2 AND head.session_id = $3), 0),
                COALESCE((SELECT head.branch_path FROM messages head
                           WHERE head.id = locked.head_message_id
                             AND head.space_id = $2 AND head.session_id = $3), $10),
                $8
           FROM locked
         RETURNING id, space_id, session_id, user_id, sender_agent_id, role, content, metadata_json, parent_message_id, run_id, created_at
       ), touched AS (
         UPDATE sessions
            SET updated_at = $8,
                head_message_id = (SELECT id FROM inserted)
          WHERE id = $3 AND space_id = $2 AND EXISTS (SELECT 1 FROM inserted)
         RETURNING 1
       )
       SELECT * FROM inserted`,
      [
        randomUUID(),
        spaceId,
        sessionId,
        storedUserId,
        input.role,
        input.content,
        messageMetadataParam(input.metadata),
        now,
        input.run_id ?? null,
        ROOT_BRANCH_PATH,
      ],
    ));
    const inserted = result.rows[0];
    if (!inserted) {
      throw new Error(`Session '${sessionId}' is unavailable for an append`);
    }
    return messageToOut(inserted);
  }

  async addAssistantMessageForRun(
    spaceId: string,
    userId: string,
    sessionId: string,
    runId: string,
    input: Omit<AddMessageInput, "role">,
  ): Promise<MessageOut | null> {
    const session = await this.getSession(spaceId, userId, sessionId);
    if (!session) return null;
    const now = new Date().toISOString();
    await this.lockConversationForAppend(spaceId, sessionId);
    const inserted = await withBranchPositionRetry(() => this.db.query<MessageRow>(
      // `uq_messages_assistant_run` makes the reply for one Run unique, so a
      // retried finalization inserts nothing and falls through to the read
      // below. The session lock keeps the parent and the new head consistent
      // for the insert that does win.
      // See `insertAttributedMessage` on why the head's depth and branch are
      // read in a subquery of the insert rather than joined inside `locked`.
      `WITH locked AS (
         SELECT session_row.id, session_row.head_message_id
           FROM sessions session_row
          WHERE session_row.id = $3 AND session_row.space_id = $2
          FOR UPDATE
       ), inserted AS (
         INSERT INTO messages
           (id, space_id, session_id, user_id, sender_agent_id, role, content, metadata_json,
            parent_message_id, run_id, path_depth, branch_path, created_at)
         SELECT $1, $2, $3, $4, NULL, 'assistant', $5, $6::jsonb,
                locked.head_message_id, $8,
                COALESCE((SELECT head.path_depth + 1 FROM messages head
                           WHERE head.id = locked.head_message_id
                             AND head.space_id = $2 AND head.session_id = $3), 0),
                COALESCE((SELECT head.branch_path FROM messages head
                           WHERE head.id = locked.head_message_id
                             AND head.space_id = $2 AND head.session_id = $3), $9),
                $7
           FROM locked
         -- Targeted, not a bare DO NOTHING: an untargeted clause absorbs
         -- *every* unique violation on the table, including a
         -- uq_messages_branch_position collision, which would then look
         -- like "this Run's reply is already written" and drop the message
         -- instead of reaching the retry. The target names the partial
         -- idempotency index, so only that conflict is the no-op.
         ON CONFLICT (space_id, run_id) WHERE role = 'assistant' AND run_id IS NOT NULL
         DO NOTHING
         RETURNING id, space_id, session_id, user_id, sender_agent_id, role, content, metadata_json, parent_message_id, run_id, created_at
       ), touched AS (
         UPDATE sessions
            SET updated_at = $7,
                head_message_id = (SELECT id FROM inserted)
          WHERE id = $3
            AND space_id = $2
            AND EXISTS (SELECT 1 FROM inserted)
         RETURNING 1
       )
       SELECT * FROM inserted`,
      [
        randomUUID(),
        spaceId,
        sessionId,
        userId,
        input.content,
        messageMetadataParam(input.metadata),
        now,
        runId,
        ROOT_BRANCH_PATH,
      ],
    ));
    const created = inserted.rows[0];
    if (created) return messageToOut(created);

    const existing = await this.db.query<MessageRow>(
      `SELECT id, space_id, session_id, user_id, sender_agent_id, role, content,
              metadata_json, parent_message_id, run_id, created_at
         FROM messages
        WHERE space_id = $1
          AND session_id = $2
          AND role = 'assistant'
          AND run_id = $3
        LIMIT 1`,
      [spaceId, sessionId, runId],
    );
    return existing.rows[0] ? messageToOut(existing.rows[0]) : null;
  }

  async addRoomAgentMessageForRun(input: {
    space_id: string;
    session_id: string;
    sender_agent_id: string;
    run_id: string;
    content: string;
    metadata?: MessageMetadata | null;
  }): Promise<MessageOut | null> {
    const now = new Date().toISOString();
    await this.lockConversationForAppend(input.space_id, input.session_id);
    const inserted = await withBranchPositionRetry(() => this.db.query<MessageRow>(
      // Insert-or-update on the Run: a Room turn is written once when it
      // finishes and rewritten if the Run finalizes again. The update keeps
      // the row's existing position on the path — only the head-advancing
      // insert moves it.
      `WITH authorized AS (
         SELECT session.id AS session_id,
                task.room_id
           FROM runs run_row
           JOIN agent_run_groups task
             ON task.id = run_row.run_group_id
            AND task.space_id = run_row.space_id
            AND task.session_id = run_row.session_id
            AND task.project_id = run_row.project_id
           JOIN sessions session
             ON session.id = task.session_id
            AND session.space_id = task.space_id
            AND session.room_id = task.room_id
            AND session.project_id = task.project_id
            AND session.status = 'active'
          WHERE run_row.id = $8
            AND run_row.space_id = $2
            AND run_row.session_id = $3
            AND run_row.agent_id = $4
       ), locked AS (
         SELECT session_row.id, session_row.head_message_id
           FROM sessions session_row
           JOIN authorized ON authorized.session_id = session_row.id
          WHERE session_row.space_id = $2
          FOR UPDATE OF session_row
       ), inserted AS (
         INSERT INTO messages (
           id, space_id, session_id, user_id, sender_agent_id, role, content,
           metadata_json, parent_message_id, run_id, path_depth, branch_path, created_at
         )
         SELECT $1, $2, authorized.session_id, NULL, $4, 'assistant', $5,
                jsonb_build_object('room_id', authorized.room_id)
                  || $6::jsonb,
                locked.head_message_id, $8,
                COALESCE((SELECT head.path_depth + 1 FROM messages head
                           WHERE head.id = locked.head_message_id
                             AND head.space_id = $2
                             AND head.session_id = authorized.session_id), 0),
                COALESCE((SELECT head.branch_path FROM messages head
                           WHERE head.id = locked.head_message_id
                             AND head.space_id = $2
                             AND head.session_id = authorized.session_id), $9),
                $7
           FROM authorized JOIN locked ON locked.id = authorized.session_id
         -- Targeted, not a bare DO NOTHING: an untargeted clause absorbs
         -- *every* unique violation on the table, including a
         -- uq_messages_branch_position collision, which would then look
         -- like "this Run's reply is already written" and drop the message
         -- instead of reaching the retry. The target names the partial
         -- idempotency index, so only that conflict is the no-op.
         ON CONFLICT (space_id, run_id) WHERE role = 'assistant' AND run_id IS NOT NULL
         DO NOTHING
         RETURNING id, space_id, session_id, user_id, sender_agent_id, role,
                   content, metadata_json, parent_message_id, run_id, created_at
       ), updated AS (
         UPDATE messages message
            SET content = $5,
                metadata_json = jsonb_build_object('room_id', authorized.room_id)
                  || $6::jsonb
           FROM authorized
          WHERE NOT EXISTS (SELECT 1 FROM inserted)
            AND message.space_id = $2
            AND message.session_id = authorized.session_id
            AND message.role = 'assistant'
            AND message.sender_agent_id = $4
            AND message.run_id = $8
         RETURNING message.id, message.space_id, message.session_id,
                   message.user_id, message.sender_agent_id, message.role,
                   message.content, message.metadata_json,
                   message.parent_message_id, message.run_id, message.created_at
       ), touched AS (
         UPDATE sessions
            SET updated_at = $7,
                head_message_id = COALESCE(
                  (SELECT id FROM inserted),
                  sessions.head_message_id
                )
          WHERE id = $3
            AND space_id = $2
            AND (
              EXISTS (SELECT 1 FROM inserted)
              OR EXISTS (SELECT 1 FROM updated)
            )
         RETURNING 1
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT * FROM updated`,
      [
        randomUUID(),
        input.space_id,
        input.session_id,
        input.sender_agent_id,
        input.content,
        messageMetadataParam(input.metadata),
        now,
        input.run_id,
        ROOT_BRANCH_PATH,
      ],
    ));
    const created = inserted.rows[0];
    if (created) return messageToOut(created);
    const existing = await this.db.query<MessageRow>(
      `SELECT id, space_id, session_id, user_id, sender_agent_id, role,
              content, metadata_json, parent_message_id, run_id, created_at
         FROM messages
        WHERE space_id = $1
          AND session_id = $2
          AND role = 'assistant'
          AND run_id = $3
        LIMIT 1`,
      [input.space_id, input.session_id, input.run_id],
    );
    return existing.rows[0] ? messageToOut(existing.rows[0]) : null;
  }

  async reflectSession(
    spaceId: string,
    userId: string,
    sessionId: string,
  ): Promise<{ session_id: string; proposals_created: number } | null> {
    const session = await this.getSession(spaceId, userId, sessionId);
    if (!session) return null;
    const messages = await this.listMessages(spaceId, userId, sessionId, 200, 0);
    if (!messages) return null;
    const usable = messages
      .filter((message) => message.content.trim().length > 0)
      .slice(-40);
    if (usable.length === 0) return { session_id: sessionId, proposals_created: 0 };

    const transcript = usable
      .map((message) => `${message.role}: ${message.content.trim()}`)
      .join("\n\n")
      .slice(0, 12_000);
    const title = session.title
      ? `Session reflection: ${session.title}`.slice(0, 512)
      : "Session reflection";
    await insertProposalRow(this.db, {
      spaceId,
      proposalType: "memory_create",
      title,
      payload: {
        operation: "create",
        proposed_content: transcript,
        memory_type: "experience",
        target_scope: "user",
        target_namespace: "session.reflect",
        target_visibility: "private",
        owner_user_id: userId,
        subject_user_id: userId,
        source_session_id: sessionId,
        source_message_ids: usable.map((message) => message.id),
        provenance_entries: [
          {
            source_type: "session",
            source_id: sessionId,
            source_trust: "user_confirmed",
            evidence_json: { message_count: usable.length },
          },
        ],
      },
      projectFolderId: session.project_folder_id,
      rationale: "Session reflection requested by the user.",
      createdByUserId: userId,
      visibility: "space_shared",
      riskLevel: "low",
    });
    return { session_id: sessionId, proposals_created: 1 };
  }

}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Retries a message append that lost a race for its position on the branch.
 *
 * Two concurrent appends to one conversation each derive their depth from the
 * session head. The session-row lock serializes them, but under READ COMMITTED
 * the waiting statement's snapshot was taken before the lock was granted, so
 * it still computes the depth the other writer just used.
 * `uq_messages_branch_position` rejects that second row; a fresh attempt runs
 * a new statement, takes a new snapshot, and sees the committed head.
 *
 * The wait between attempts is what makes the bound sufficient rather than
 * merely generous. Retrying immediately puts every loser back on the same
 * lock the winner is about to release, so they wake together and collide
 * again — with N contenders that burns roughly N attempts. Jittered backoff
 * spreads them out, so the attempt count bounds genuine contention instead of
 * a thundering herd of the losers' own making.
 */
async function withBranchPositionRetry<T>(attempt: () => Promise<T>): Promise<T> {
  const maxAttempts = 8;
  const baseDelayMs = 4;
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const constraint = (error as { constraint?: unknown } | null)?.constraint;
      if (
        tries >= maxAttempts
        || code !== UNIQUE_VIOLATION
        || constraint !== "uq_messages_branch_position"
      ) {
        throw error;
      }
      const ceiling = baseDelayMs * 2 ** (tries - 1);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
    }
  }
}

/**
 * Serializes message metadata for the column, rejecting a shape the readers
 * cannot make sense of. Validation happens here rather than at the routes
 * because every metadata key on a message is server-authored — the HTTP
 * surface accepts only `content` — so the shapes worth guarding are the ones
 * this repository's own callers assemble.
 */
function messageMetadataParam(value: MessageMetadata | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(MessageMetadataSchema.parse(value));
}

/**
 * Session metadata, which is a different and still open-ended thing: callers
 * stamp their own bookkeeping on a conversation (`execution_setup_started`,
 * for one) and no reader depends on a closed set.
 */
function sessionMetadataParam(value: Record<string, unknown> | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function sessionSelectSql(): string {
  return `SELECT s.id,
                 s.space_id,
                 s.user_id,
                 s.project_folder_id,
                 s.project_id,
                 s.room_id,
                 s.title,
                 s.status,
                 s.created_at,
                 s.updated_at
            FROM sessions s`;
}

function sessionToOut(row: SessionRow): SessionOut {
  return {
    id: row.id,
    space_id: row.space_id,
    user_id: row.user_id,
    project_folder_id: row.project_folder_id,
    project_id:row.project_id,
    room_id: row.room_id,
    title: row.title,
    status: row.status,
    created_at: dateValue(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateValue(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function messageToOut(row: MessageRow): MessageOut {
  return {
    id: row.id,
    session_id: row.session_id,
    space_id: row.space_id,
    user_id: row.user_id,
    sender_agent_id: row.sender_agent_id,
    role: row.role,
    content: row.content,
    metadata_json: recordOrNull(row.metadata_json),
    parent_message_id: row.parent_message_id,
    run_id: row.run_id,
    created_at: dateValue(row.created_at) ?? new Date(0).toISOString(),
  };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampLimit(limit: number): number {
  const n = Math.floor(limit);
  return n > 0 ? n : 1;
}

function dateValue(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}
