import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { insertProposalRow } from "../proposals/reviewPackets";
import type {
  MessageOut,
  SessionOut,
  SessionPage,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { projectReadAccessSql } from "../access/contentAccessSql";

export interface CreateSessionInput {
  projectFolderId?: string | null;
  projectId?:string|null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AddMessageInput {
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
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
  ): Promise<MessageOut[]> {
    const result = await this.db.query<MessageRow>(
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
                  m.created_at
             FROM messages m
            WHERE m.session_id = $1
              AND m.space_id = $2
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $3 OFFSET $4
         ) message_page
        ORDER BY message_page.created_at ASC, message_page.id ASC`,
      [sessionId, spaceId, limit, offset],
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
    return this.loadMessagePage(spaceId, sessionId, limit, offset);
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
                  m.created_at
             FROM messages m
            WHERE m.session_id = $1
              AND m.space_id = $2
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $3
         ) recent
        ORDER BY recent.created_at ASC, recent.id ASC`,
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
        jsonParam(input.metadata),
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
        jsonParam(input.metadata),
        now,
      ],
    );
    return sessionToOut(result.rows[0]!);
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
    return this.insertUserMessage(spaceId, userId, sessionId, input);
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
          SET metadata_json =
                COALESCE(metadata_json, '{}'::jsonb)
                || jsonb_build_object('run_id', $5::text)
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
    return this.insertUserMessage(spaceId, userId, sessionId, {
      ...input,
      role: "user",
    });
  }

  private async insertUserMessage(
    spaceId: string,
    userId: string,
    sessionId: string,
    input: AddMessageInput,
  ): Promise<MessageOut> {
    const now = new Date().toISOString();
    // Atomic: insert the message and touch the session's updated_at in one
    // statement (data-modifying CTEs run to completion regardless of the final
    // SELECT).
    const result = await this.db.query<MessageRow>(
      `WITH inserted AS (
         INSERT INTO messages
           (id, space_id, session_id, user_id, sender_agent_id, role, content, metadata_json, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7::jsonb, $8)
         RETURNING id, space_id, session_id, user_id, sender_agent_id, role, content, metadata_json, created_at
       ), touched AS (
         UPDATE sessions SET updated_at = $8 WHERE id = $3 RETURNING 1
       )
       SELECT * FROM inserted`,
      [
        randomUUID(),
        spaceId,
        sessionId,
        userId,
        input.role,
        input.content,
        jsonParam(input.metadata),
        now,
      ],
    );
    return messageToOut(result.rows[0]!);
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
    const metadata = { ...(input.metadata ?? {}), run_id: runId };
    const inserted = await this.db.query<MessageRow>(
      `WITH inserted AS (
         INSERT INTO messages
           (id, space_id, session_id, user_id, sender_agent_id, role, content, metadata_json, created_at)
         VALUES ($1, $2, $3, $4, NULL, 'assistant', $5, $6::jsonb, $7)
         ON CONFLICT DO NOTHING
         RETURNING id, space_id, session_id, user_id, sender_agent_id, role, content, metadata_json, created_at
       ), touched AS (
         UPDATE sessions
            SET updated_at = $7
          WHERE id = $3
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
        JSON.stringify(metadata),
        now,
      ],
    );
    const created = inserted.rows[0];
    if (created) return messageToOut(created);

    const existing = await this.db.query<MessageRow>(
      `SELECT id, space_id, session_id, user_id, sender_agent_id, role, content, metadata_json, created_at
         FROM messages
        WHERE space_id = $1
          AND session_id = $2
          AND role = 'assistant'
          AND metadata_json->>'run_id' = $3
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
    metadata?: Record<string, unknown> | null;
  }): Promise<MessageOut | null> {
    const now = new Date().toISOString();
    const metadata = { ...(input.metadata ?? {}), run_id: input.run_id };
    const inserted = await this.db.query<MessageRow>(
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
       ), inserted AS (
         INSERT INTO messages (
           id, space_id, session_id, user_id, sender_agent_id, role, content,
           metadata_json, created_at
         )
         SELECT $1, $2, authorized.session_id, NULL, $4, 'assistant', $5,
                jsonb_build_object('room_id', authorized.room_id)
                  || $6::jsonb,
                $7
           FROM authorized
         ON CONFLICT DO NOTHING
         RETURNING id, space_id, session_id, user_id, sender_agent_id, role,
                   content, metadata_json, created_at
       ), touched AS (
         UPDATE sessions
            SET updated_at = $7
          WHERE id = $3
            AND EXISTS (SELECT 1 FROM inserted)
         RETURNING 1
       )
       SELECT * FROM inserted`,
      [
        randomUUID(),
        input.space_id,
        input.session_id,
        input.sender_agent_id,
        input.content,
        JSON.stringify(metadata),
        now,
        input.run_id,
      ],
    );
    const created = inserted.rows[0];
    if (created) return messageToOut(created);
    const existing = await this.db.query<MessageRow>(
      `SELECT id, space_id, session_id, user_id, sender_agent_id, role,
              content, metadata_json, created_at
         FROM messages
        WHERE space_id = $1
          AND session_id = $2
          AND role = 'assistant'
          AND metadata_json->>'run_id' = $3
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

function jsonParam(value: Record<string, unknown> | null | undefined): string | null {
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
