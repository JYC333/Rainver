import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import type { SessionOut } from "@agent-space/protocol";

export interface RoomRecord {
  id: string;
  space_id: string;
  project_id: string;
  project_folder_id: string | null;
  created_by_user_id: string;
  title: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  roster_revision: number;
}

export interface RoomUserMemberRecord {
  id: string;
  space_id: string;
  room_id: string;
  user_id: string;
  role: "owner" | "member";
  status: "active" | "removed";
  created_at: string;
  updated_at: string;
}

export interface RoomAgentMemberRecord {
  id: string;
  space_id: string;
  room_id: string;
  agent_id: string;
  agent_name: string;
  agent_kind: string;
  role: "manager" | "member";
  status: "active" | "removed";
  private_shared_user_ids: string[];
  created_at: string;
  updated_at: string;
}

const ROOM_COLUMNS = `
  id, space_id, project_id, project_folder_id, created_by_user_id, title, status,
  created_at, updated_at, archived_at
  , roster_revision::int AS roster_revision
`;
const ROOM_SELECT = `
  room.id, room.space_id, room.project_id, room.project_folder_id,
  room.created_by_user_id, room.title,
  room.status, room.created_at, room.updated_at, room.archived_at,
  room.roster_revision::int AS roster_revision
`;
const ROOM_PROJECT_READABLE = `
  EXISTS (
    SELECT 1
      FROM projects room_project
      JOIN spaces room_project_space
        ON room_project_space.id = room_project.space_id
      LEFT JOIN project_members room_project_member
        ON room_project_member.space_id = room_project.space_id
       AND room_project_member.project_id = room_project.id
       AND room_project_member.user_id = $2
       AND room_project_member.status = 'active'
     WHERE room_project.id = room.project_id
       AND room_project.space_id = room.space_id
       AND room_project.deleted_at IS NULL
       AND (
         room_project_space.type = 'personal'
         OR room_project.owner_user_id = $2
         OR room_project_member.user_id IS NOT NULL
       )
  )
`;

export class PgRoomRepository {
  constructor(private readonly db: Queryable) {}

  async createRoom(input: {
    space_id: string;
    project_id: string;
    project_folder_id?: string | null;
    created_by_user_id: string;
    title: string;
    now?: string;
  }): Promise<RoomRecord> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<RoomRecord>(
      `INSERT INTO rooms (
         id, space_id, project_id, project_folder_id, created_by_user_id, title, status,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)
       RETURNING ${ROOM_COLUMNS}`,
      [
        randomUUID(),
        input.space_id,
        input.project_id,
        input.project_folder_id ?? null,
        input.created_by_user_id,
        input.title,
        now,
      ],
    );
    return required(result.rows[0], "Room insert returned no row");
  }

  async addUserMember(input: {
    space_id: string;
    room_id: string;
    user_id: string;
    role: "owner" | "member";
    now?: string;
  }): Promise<RoomUserMemberRecord> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<RoomUserMemberRecord>(
      `INSERT INTO room_user_members (
         id, space_id, room_id, user_id, role, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
       RETURNING id, space_id, room_id, user_id, role, status, created_at, updated_at`,
      [randomUUID(), input.space_id, input.room_id, input.user_id, input.role, now],
    );
    return required(result.rows[0], "Room user member insert returned no row");
  }

  async addAgentMember(input: {
    space_id: string;
    room_id: string;
    agent_id: string;
    role: "manager" | "member";
    now?: string;
  }): Promise<RoomAgentMemberRecord> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<RoomAgentMemberRecord>(
      `INSERT INTO room_agent_members (
         id, space_id, room_id, agent_id, role, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
       RETURNING id, space_id, room_id, agent_id,
                 (SELECT name FROM agents
                   WHERE agents.space_id = $2 AND agents.id = $4) AS agent_name,
                 (SELECT agent_kind FROM agents
                   WHERE agents.space_id = $2 AND agents.id = $4) AS agent_kind,
                 '[]'::jsonb AS private_shared_user_ids,
                 role, status, created_at, updated_at`,
      [randomUUID(), input.space_id, input.room_id, input.agent_id, input.role, now],
    );
    return required(result.rows[0], "Room agent member insert returned no row");
  }

  async getVisibleRoom(
    spaceId: string,
    userId: string,
    roomId: string,
    lock = false,
  ): Promise<RoomRecord | null> {
    const result = await this.db.query<RoomRecord>(
      `SELECT ${ROOM_SELECT}
         FROM rooms room
         JOIN room_user_members member
           ON member.room_id = room.id
          AND member.space_id = room.space_id
          AND member.user_id = $2
          AND member.status = 'active'
        WHERE room.space_id = $1
          AND room.id = $3
          AND room.status = 'active'
          AND ${ROOM_PROJECT_READABLE}
        ${lock ? "FOR UPDATE OF room" : ""}`,
      [spaceId, userId, roomId],
    );
    return result.rows[0] ?? null;
  }

  async getRoomById(spaceId: string, roomId: string, lock = false): Promise<RoomRecord | null> {
    const result = await this.db.query<RoomRecord>(
      `SELECT ${ROOM_COLUMNS}
         FROM rooms
        WHERE space_id = $1 AND id = $2
        ${lock ? "FOR UPDATE" : ""}`,
      [spaceId, roomId],
    );
    return result.rows[0] ?? null;
  }

  async listVisibleRooms(input: {
    space_id: string;
    user_id: string;
    project_id?: string | null;
    limit: number;
    offset: number;
  }): Promise<{ items: RoomRecord[]; total: number }> {
    const params: unknown[] = [input.space_id, input.user_id];
    const projectClause = input.project_id
      ? `AND room.project_id = $${params.push(input.project_id)}`
      : "";
    const total = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM rooms room
         JOIN room_user_members member
           ON member.room_id = room.id
          AND member.space_id = room.space_id
          AND member.user_id = $2
          AND member.status = 'active'
        WHERE room.space_id = $1
          AND room.status = 'active'
          AND ${ROOM_PROJECT_READABLE}
          ${projectClause}`,
      params,
    );
    const limitIndex = params.push(input.limit);
    const offsetIndex = params.push(input.offset);
    const rows = await this.db.query<RoomRecord>(
      `SELECT ${ROOM_SELECT}
         FROM rooms room
         JOIN room_user_members member
           ON member.room_id = room.id
          AND member.space_id = room.space_id
          AND member.user_id = $2
          AND member.status = 'active'
        WHERE room.space_id = $1
          AND room.status = 'active'
          AND ${ROOM_PROJECT_READABLE}
          ${projectClause}
        ORDER BY room.updated_at DESC, room.id DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return { items: rows.rows, total: Number(total.rows[0]?.total ?? 0) };
  }

  async listUserMembers(spaceId: string, roomId: string): Promise<RoomUserMemberRecord[]> {
    const result = await this.db.query<RoomUserMemberRecord>(
      `SELECT id, space_id, room_id, user_id, role, status, created_at, updated_at
         FROM room_user_members
        WHERE space_id = $1 AND room_id = $2 AND status = 'active'
        ORDER BY role DESC, created_at ASC, id ASC`,
      [spaceId, roomId],
    );
    return result.rows;
  }

  async listAgentMembers(spaceId: string, roomId: string): Promise<RoomAgentMemberRecord[]> {
    const result = await this.db.query<RoomAgentMemberRecord>(
      `SELECT member.id, member.space_id, member.room_id, member.agent_id,
              agent.name AS agent_name, agent.agent_kind,
              COALESCE((
                SELECT jsonb_agg(grant_row.grantee_user_id ORDER BY grant_row.grantee_user_id)
                  FROM room_agent_access_grants grant_row
                 WHERE grant_row.space_id = member.space_id
                   AND grant_row.room_id = member.room_id
                   AND grant_row.agent_id = member.agent_id
                   AND grant_row.revoked_at IS NULL
              ), '[]'::jsonb) AS private_shared_user_ids,
              member.role, member.status, member.created_at, member.updated_at
         FROM room_agent_members member
         JOIN agents agent
           ON agent.space_id = member.space_id AND agent.id = member.agent_id
        WHERE member.space_id = $1 AND member.room_id = $2
          AND member.status = 'active' AND agent.status = 'active'
        ORDER BY member.role DESC, member.created_at ASC, member.id ASC`,
      [spaceId, roomId],
    );
    return result.rows;
  }

  async getConversation(
    spaceId: string,
    roomId: string,
    sessionId: string,
  ): Promise<SessionOut | null> {
    const result = await this.db.query<{
      id: string;
      space_id: string;
      room_id: string;
      project_id: string;
      project_folder_id: string | null;
      title: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, space_id, room_id, project_id, project_folder_id,
              title, status, created_at, updated_at
         FROM sessions
        WHERE space_id = $1
          AND room_id = $2
          AND id = $3
          AND status = 'active'`,
      [spaceId, roomId, sessionId],
    );
    const row = result.rows[0];
    return row
      ? {
          ...row,
          user_id: null,
          project_folder_id: row.project_folder_id,
        }
      : null;
  }

  async listConversations(input: {
    space_id: string;
    room_id: string;
    limit: number;
    offset: number;
  }): Promise<{ items: SessionOut[]; total: number }> {
    const total = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM sessions
        WHERE space_id = $1 AND room_id = $2 AND status = 'active'`,
      [input.space_id, input.room_id],
    );
    const rows = await this.db.query<{
      id: string;
      space_id: string;
      room_id: string;
      project_id: string;
      title: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, space_id, room_id, project_id, title, status, created_at, updated_at
         FROM sessions
        WHERE space_id = $1 AND room_id = $2 AND status = 'active'
        ORDER BY created_at DESC, id DESC
        LIMIT $3 OFFSET $4`,
      [input.space_id, input.room_id, input.limit, input.offset],
    );
    return {
      items: rows.rows.map((row) => ({
        ...row,
        user_id: null,
        project_folder_id: null,
      })),
      total: Number(total.rows[0]?.total ?? 0),
    };
  }

  async listConversationTaskGroupIds(
    spaceId: string,
    roomId: string,
    sessionId: string,
  ): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id
         FROM agent_run_groups
        WHERE space_id = $1
          AND room_id = $2
          AND session_id = $3
        ORDER BY created_at ASC, id ASC`,
      [spaceId, roomId, sessionId],
    );
    return result.rows.map((row) => row.id);
  }
}

function required<T>(value: T | null | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}
