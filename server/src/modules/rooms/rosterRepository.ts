import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import { contentReadSql } from "../access/contentAccessSql.js";

export interface RoomRosterAgentCandidate {
  agent_id: string;
  name: string;
  agent_kind: string;
  owner_user_id: string | null;
  visibility: string;
  in_room: boolean;
  member_status: "active" | "removed" | null;
  private: boolean;
  shared_with_user_ids: string[];
  workspace_mode: "location" | "managed" | null;
  workspace_archive_available: boolean;
}

export interface RoomInvitationRecord {
  id: string;
  space_id: string;
  room_id: string;
  invitee_user_id: string;
  invited_by_user_id: string;
  status: "pending" | "active" | "rejected" | "expired" | "cancelled" | "invalidated";
  required_roster_revision: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface RoomInvitationApprovalRecord {
  id: string;
  space_id: string;
  invitation_id: string;
  agent_id: string;
  owner_user_id: string;
  status: "pending" | "approved" | "rejected" | "invalidated";
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

const INVITATION_COLUMNS = `
  id, space_id, room_id, invitee_user_id, invited_by_user_id, status,
  required_roster_revision::int AS required_roster_revision,
  expires_at, created_at, updated_at, resolved_at
`;

const INVITATION_COLUMNS_ALIASED = `
  invitation.id, invitation.space_id, invitation.room_id,
  invitation.invitee_user_id, invitation.invited_by_user_id, invitation.status,
  invitation.required_roster_revision::int AS required_roster_revision,
  invitation.expires_at, invitation.created_at, invitation.updated_at,
  invitation.resolved_at
`;

const APPROVAL_COLUMNS = `
  id, space_id, invitation_id, agent_id, owner_user_id, status,
  decided_at, created_at, updated_at
`;

export class PgRoomRosterRepository {
  constructor(private readonly db: Queryable) {}

  async listAgentCandidates(input: {
    space_id: string;
    user_id: string;
    room_id: string;
    limit: number;
    offset: number;
  }): Promise<{ items: RoomRosterAgentCandidate[]; total: number }> {
    const where = `
      a.space_id = $1
      AND a.agent_kind <> 'system_assistant'
      AND a.status = 'active'
      AND (a.project_id IS NULL OR a.project_id = room.project_id)
      AND (a.visibility <> 'selected_users' OR a.owner_user_id = $2)
      AND ${contentReadSql("agent", "a", "$2")}`;
    const params: unknown[] = [input.space_id, input.user_id, input.room_id];
    const total = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM agents a
         JOIN rooms room ON room.space_id = a.space_id AND room.id = $3
        WHERE ${where}`,
      params,
    );
    const rows = await this.db.query<RoomRosterAgentCandidate>(
      `SELECT a.id AS agent_id,
              a.name,
              a.agent_kind,
              a.owner_user_id,
              a.visibility,
              COALESCE(member.status = 'active', false) AS in_room,
              member.status AS member_status,
              (a.visibility <> 'space_shared') AS private,
              COALESCE((
                SELECT jsonb_agg(grant_row.grantee_user_id ORDER BY grant_row.grantee_user_id)
                  FROM room_agent_access_grants grant_row
                 WHERE grant_row.space_id = a.space_id
                   AND grant_row.room_id = $3
                   AND grant_row.agent_id = a.id
                   AND grant_row.revoked_at IS NULL
              ), '[]'::jsonb) AS shared_with_user_ids
              ,binding.workspace_mode,
              COALESCE(EXISTS (
                SELECT 1
                  FROM host_threads archived_thread
                  JOIN sessions archived_conversation
                    ON archived_conversation.id = archived_thread.session_id
                   AND archived_conversation.space_id = archived_thread.space_id
                 WHERE archived_thread.space_id = a.space_id
                   AND archived_thread.agent_id = a.id
                   AND archived_thread.execution_host_id = binding.execution_host_id
                   AND archived_thread.container_kind = 'conversation'
                   AND archived_thread.workspace_mode = 'managed'
                   AND archived_thread.status = 'closed'
                   AND archived_conversation.room_id = $3
                   AND EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements(COALESCE(host.managed_workspaces_json, '[]'::jsonb)) report
                      WHERE report->>'agent_id' = a.id::text
                        AND report->>'container_kind' = 'conversation'
                        AND report->>'container_id' = archived_thread.session_id
                        AND report->>'archived_available' = 'true'
                   )
              ), false) AS workspace_archive_available
         FROM agents a
         JOIN rooms room ON room.space_id = a.space_id AND room.id = $3
        LEFT JOIN room_agent_members member
           ON member.space_id = a.space_id
          AND member.room_id = $3
          AND member.agent_id = a.id
        LEFT JOIN LATERAL (
          SELECT profile.execution_host_id, profile.workspace_mode
            FROM agent_runtime_profiles profile
           WHERE profile.space_id = a.space_id
             AND profile.agent_id = a.id
             AND profile.enabled = true
           ORDER BY profile.is_default DESC, profile.created_at ASC, profile.id ASC
           LIMIT 1
        ) binding ON true
        LEFT JOIN hosts host ON host.id = binding.execution_host_id
        WHERE ${where}
        ORDER BY member.status = 'active' DESC, a.created_at ASC, a.id ASC
        LIMIT $4 OFFSET $5`,
      [...params, input.limit, input.offset],
    );
    return { items: rows.rows, total: Number(total.rows[0]?.total ?? 0) };
  }

  async getAgentForAdd(input: {
    space_id: string;
    user_id: string;
    room_id: string;
    agent_id: string;
    lock?: boolean;
  }): Promise<{
    id: string;
    owner_user_id: string | null;
    visibility: string;
    agent_kind: string;
    status: string;
    project_id: string | null;
  } | null> {
    const result = await this.db.query<{
      id: string;
      owner_user_id: string | null;
      visibility: string;
      agent_kind: string;
      status: string;
      project_id: string | null;
    }>(
      `SELECT a.id, a.owner_user_id, a.visibility, a.agent_kind, a.status, a.project_id
         FROM agents a
         JOIN rooms room
           ON room.space_id = a.space_id
          AND room.id = $3
        WHERE a.space_id = $1
          AND a.id = $4
          AND a.agent_kind <> 'system_assistant'
          AND a.status = 'active'
          AND (a.project_id IS NULL OR a.project_id = room.project_id)
          AND (a.visibility <> 'selected_users' OR a.owner_user_id = $2)
          AND ${contentReadSql("agent", "a", "$2")}
        ${input.lock ? "FOR UPDATE OF a" : ""}`,
      [input.space_id, input.user_id, input.room_id, input.agent_id],
    );
    return result.rows[0] ?? null;
  }

  async getAgentMember(input: {
    space_id: string;
    room_id: string;
    agent_id: string;
    lock?: boolean;
  }): Promise<{ id: string; role: string; status: string } | null> {
    const result = await this.db.query<{ id: string; role: string; status: string }>(
      `SELECT id, role, status
         FROM room_agent_members
        WHERE space_id = $1 AND room_id = $2 AND agent_id = $3
        ${input.lock ? "FOR UPDATE" : ""}`,
      [input.space_id, input.room_id, input.agent_id],
    );
    return result.rows[0] ?? null;
  }

  async upsertSpecialistMember(input: {
    space_id: string;
    room_id: string;
    agent_id: string;
  }): Promise<void> {
    const existing = await this.getAgentMember({ ...input, lock: true });
    if (existing?.role === "manager") throw new Error("managed_room_agent_immutable");
    if (existing?.status === "active") return;
    if (existing) {
      await this.db.query(
        `UPDATE room_agent_members
            SET role = 'member', status = 'active', updated_at = now()
          WHERE space_id = $1 AND room_id = $2 AND agent_id = $3`,
        [input.space_id, input.room_id, input.agent_id],
      );
      return;
    }
    await this.db.query(
      `INSERT INTO room_agent_members (
         id, space_id, room_id, agent_id, role, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
      [randomUUID(), input.space_id, input.room_id, input.agent_id],
    );
  }

  async incrementRosterRevision(spaceId: string, roomId: string): Promise<number> {
    const result = await this.db.query<{ roster_revision: number }>(
      `UPDATE rooms
          SET roster_revision = roster_revision + 1,
              updated_at = now()
        WHERE space_id = $1 AND id = $2
        RETURNING roster_revision`,
      [spaceId, roomId],
    );
    return Number(result.rows[0]?.roster_revision ?? 0);
  }

  async revokeAgentGrants(input: {
    space_id: string;
    room_id: string;
    agent_id: string;
    revoked_by_user_id: string;
  }): Promise<number> {
    const result = await this.db.query(
      `UPDATE room_agent_access_grants
          SET revoked_at = now(), revoked_by_user_id = $4
        WHERE space_id = $1 AND room_id = $2 AND agent_id = $3 AND revoked_at IS NULL`,
      [input.space_id, input.room_id, input.agent_id, input.revoked_by_user_id],
    );
    return result.rowCount ?? 0;
  }

  async revokeUserGrants(input: {
    space_id: string;
    room_id: string;
    user_id: string;
    revoked_by_user_id: string;
  }): Promise<number> {
    const result = await this.db.query(
      `UPDATE room_agent_access_grants
          SET revoked_at = now(), revoked_by_user_id = $4
        WHERE space_id = $1 AND room_id = $2 AND grantee_user_id = $3 AND revoked_at IS NULL`,
      [input.space_id, input.room_id, input.user_id, input.revoked_by_user_id],
    );
    return result.rowCount ?? 0;
  }

  async grantPrivateAgent(input: {
    space_id: string;
    room_id: string;
    agent_id: string;
    grantee_user_id: string;
    granted_by_user_id: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO room_agent_access_grants (
         id, space_id, room_id, agent_id, grantee_user_id, granted_by_user_id,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (room_id, agent_id, grantee_user_id) WHERE revoked_at IS NULL
       DO UPDATE SET granted_by_user_id = EXCLUDED.granted_by_user_id`,
      [randomUUID(), input.space_id, input.room_id, input.agent_id, input.grantee_user_id, input.granted_by_user_id],
    );
  }

  async listActiveRoomUserIds(spaceId: string, roomId: string): Promise<string[]> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM room_user_members
        WHERE space_id = $1 AND room_id = $2 AND status = 'active'
        ORDER BY user_id ASC`,
      [spaceId, roomId],
    );
    return result.rows.map((row) => row.user_id);
  }

  async listPrivateRoster(input: { space_id: string; room_id: string }): Promise<Array<{
    agent_id: string;
    owner_user_id: string;
    visibility: string;
  }>> {
    const result = await this.db.query<{ agent_id: string; owner_user_id: string; visibility: string }>(
      `SELECT member.agent_id, agent.owner_user_id, agent.visibility
         FROM room_agent_members member
         JOIN agents agent
           ON agent.id = member.agent_id AND agent.space_id = member.space_id
        WHERE member.space_id = $1 AND member.room_id = $2
          AND member.status = 'active'
          AND member.role = 'member'
          AND agent.status = 'active'
          AND agent.visibility <> 'space_shared'
          AND agent.owner_user_id IS NOT NULL
        ORDER BY member.agent_id ASC`,
      [input.space_id, input.room_id],
    );
    return result.rows;
  }

  async createInvitation(input: {
    space_id: string;
    room_id: string;
    invitee_user_id: string;
    invited_by_user_id: string;
    required_roster_revision: number;
    expires_at: string;
  }): Promise<RoomInvitationRecord> {
    const result = await this.db.query<RoomInvitationRecord>(
      `INSERT INTO room_user_invitations (
         id, space_id, room_id, invitee_user_id, invited_by_user_id, status,
         required_roster_revision, expires_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, now(), now())
       RETURNING ${INVITATION_COLUMNS}`,
      [randomUUID(), input.space_id, input.room_id, input.invitee_user_id, input.invited_by_user_id, input.required_roster_revision, input.expires_at],
    );
    return required(result.rows[0], "Room invitation insert returned no row");
  }

  async createApproval(input: {
    space_id: string;
    invitation_id: string;
    agent_id: string;
    owner_user_id: string;
  }): Promise<RoomInvitationApprovalRecord> {
    const result = await this.db.query<RoomInvitationApprovalRecord>(
      `INSERT INTO room_invitation_agent_approvals (
         id, space_id, invitation_id, agent_id, owner_user_id, status,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'pending', now(), now())
       RETURNING ${APPROVAL_COLUMNS}`,
      [randomUUID(), input.space_id, input.invitation_id, input.agent_id, input.owner_user_id],
    );
    return required(result.rows[0], "Room invitation approval insert returned no row");
  }

  async getInvitation(input: {
    space_id: string;
    invitation_id: string;
    lock?: boolean;
  }): Promise<RoomInvitationRecord | null> {
    const result = await this.db.query<RoomInvitationRecord>(
      `SELECT ${INVITATION_COLUMNS}
         FROM room_user_invitations
        WHERE space_id = $1 AND id = $2
        ${input.lock ? "FOR UPDATE" : ""}`,
      [input.space_id, input.invitation_id],
    );
    return result.rows[0] ?? null;
  }

  async listInvitations(input: {
    space_id: string;
    room_id: string;
    user_id: string;
    limit: number;
    offset: number;
  }): Promise<{ items: RoomInvitationRecord[]; total: number }> {
    const params: unknown[] = [input.space_id, input.room_id, input.user_id];
    const total = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM room_user_invitations invitation
        WHERE invitation.space_id = $1 AND invitation.room_id = $2
          AND (invitation.invited_by_user_id = $3
            OR invitation.invitee_user_id = $3
            OR EXISTS (
              SELECT 1 FROM room_invitation_agent_approvals approval
               WHERE approval.space_id = invitation.space_id
                 AND approval.invitation_id = invitation.id
                 AND approval.owner_user_id = $3
            ))`,
      params,
    );
    const rows = await this.db.query<RoomInvitationRecord>(
      `SELECT DISTINCT ${INVITATION_COLUMNS_ALIASED}
         FROM room_user_invitations invitation
        WHERE invitation.space_id = $1 AND invitation.room_id = $2
          AND (invitation.invited_by_user_id = $3
            OR invitation.invitee_user_id = $3
            OR EXISTS (
              SELECT 1 FROM room_invitation_agent_approvals approval
               WHERE approval.space_id = invitation.space_id
                 AND approval.invitation_id = invitation.id
                 AND approval.owner_user_id = $3
            ))
        ORDER BY invitation.created_at DESC, invitation.id DESC
        LIMIT $4 OFFSET $5`,
      [...params, input.limit, input.offset],
    );
    return { items: rows.rows, total: Number(total.rows[0]?.total ?? 0) };
  }

  async listApprovals(spaceId: string, invitationId: string, lock = false): Promise<RoomInvitationApprovalRecord[]> {
    const result = await this.db.query<RoomInvitationApprovalRecord>(
      `SELECT ${APPROVAL_COLUMNS}
         FROM room_invitation_agent_approvals
        WHERE space_id = $1 AND invitation_id = $2
        ORDER BY agent_id ASC
        ${lock ? "FOR UPDATE" : ""}`,
      [spaceId, invitationId],
    );
    return result.rows;
  }

  async updateApproval(input: {
    space_id: string;
    invitation_id: string;
    agent_id: string;
    owner_user_id: string;
    status: "approved" | "rejected";
  }): Promise<RoomInvitationApprovalRecord | null> {
    const result = await this.db.query<RoomInvitationApprovalRecord>(
      `UPDATE room_invitation_agent_approvals
          SET status = $5, decided_at = now(), updated_at = now()
        WHERE space_id = $1 AND invitation_id = $2 AND agent_id = $3
          AND owner_user_id = $4 AND status = 'pending'
        RETURNING ${APPROVAL_COLUMNS}`,
      [input.space_id, input.invitation_id, input.agent_id, input.owner_user_id, input.status],
    );
    return result.rows[0] ?? null;
  }

  async updateInvitationStatus(input: {
    space_id: string;
    invitation_id: string;
    status: RoomInvitationRecord["status"];
  }): Promise<RoomInvitationRecord | null> {
    const result = await this.db.query<RoomInvitationRecord>(
      `UPDATE room_user_invitations
          SET status = $3::varchar,
              resolved_at = CASE WHEN $3::varchar IN ('pending') THEN NULL ELSE now() END,
              updated_at = now()
        WHERE space_id = $1 AND id = $2
        RETURNING ${INVITATION_COLUMNS}`,
      [input.space_id, input.invitation_id, input.status],
    );
    return result.rows[0] ?? null;
  }

  async invalidateApprovals(spaceId: string, invitationId: string): Promise<void> {
    await this.db.query(
      `UPDATE room_invitation_agent_approvals
          SET status = 'invalidated', updated_at = now()
        WHERE space_id = $1 AND invitation_id = $2 AND status = 'pending'`,
      [spaceId, invitationId],
    );
  }

  async lockUserMember(spaceId: string, roomId: string, userId: string): Promise<{
    id: string;
    role: string;
    status: string;
  } | null> {
    const result = await this.db.query<{ id: string; role: string; status: string }>(
      `SELECT id, role, status FROM room_user_members
        WHERE space_id = $1 AND room_id = $2 AND user_id = $3
        FOR UPDATE`,
      [spaceId, roomId, userId],
    );
    return result.rows[0] ?? null;
  }

  async activeMemberIds(spaceId: string, roomId: string): Promise<string[]> {
    return this.listActiveRoomUserIds(spaceId, roomId);
  }
}

function required<T>(value: T | null | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}
