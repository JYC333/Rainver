import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import {
  contentReadSql,
  projectReadAccessSql,
} from "../access/contentAccessSql.js";
import { canReadProject } from "../projects/access.js";

export interface AgentRunGroupRecord {
  id: string;
  space_id: string;
  root_run_id: string | null;
  manager_user_id: string;
  manager_agent_id: string | null;
  room_id: string | null;
  session_id: string | null;
  trigger_message_id: string | null;
  project_id: string | null;
  project_folder_id: string | null;
  title: string;
  goal: string;
  status: string;
  budget_json: Record<string, unknown> | null;
  policy_snapshot_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface AgentRunGroupMemberRecord {
  id: string;
  space_id: string;
  group_id: string;
  agent_id: string;
  role: string;
  status: string;
  capabilities_json: Record<string, unknown> | null;
  context_policy_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRunGroupMemberWithAgentStatus extends AgentRunGroupMemberRecord {
  agent_status: string | null;
  agent_kind: string | null;
}

export interface AgentRunMessageRecord {
  id: string;
  space_id: string;
  group_id: string;
  run_id: string | null;
  parent_message_id: string | null;
  sender_actor_ref_json: Record<string, unknown>;
  sender_user_id: string | null;
  sender_agent_id: string | null;
  message_type: string;
  content: string;
  mentions_json: unknown[];
  metadata_json: Record<string, unknown> | null;
  created_at: string;
}

export interface RunDelegationRecord {
  id: string;
  space_id: string;
  group_id: string;
  parent_run_id: string;
  child_run_id: string | null;
  request_message_id: string | null;
  requesting_agent_id: string;
  target_agent_id: string;
  requested_by_user_id: string | null;
  policy_decision_record_id: string | null;
  status: string;
  instruction: string;
  reason: string | null;
  budget_json: Record<string, unknown> | null;
  context_policy_json: Record<string, unknown> | null;
  result_summary: string | null;
  tool_call_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface RunDelegationLifecycleUpdateResult {
  delegation: RunDelegationRecord | null;
  changed: boolean;
}

export interface AgentStatusRecord {
  id: string;
  status: string;
  agent_kind: string;
}

export interface AgentCapabilitySnapshotRecord {
  id: string;
  name: string;
  description: string | null;
  role_instruction: string | null;
  capabilities_json: unknown[];
}

const GROUP_COLUMNS = `
  id, space_id, root_run_id, manager_user_id, manager_agent_id, room_id,
  session_id, trigger_message_id, project_id, project_folder_id, title, goal,
  status, budget_json, policy_snapshot_json, created_at, updated_at, ended_at
`;

const MEMBER_COLUMNS = `
  id, space_id, group_id, agent_id, role, status, capabilities_json,
  context_policy_json, created_at, updated_at
`;

const MEMBER_COLUMNS_ALIASED = `
  m.id, m.space_id, m.group_id, m.agent_id, m.role, m.status,
  m.capabilities_json, m.context_policy_json, m.created_at, m.updated_at
`;

const MESSAGE_COLUMNS = `
  id, space_id, group_id, run_id, parent_message_id, sender_actor_ref_json,
  sender_user_id, sender_agent_id, message_type, content, mentions_json,
  metadata_json, created_at
`;

const DELEGATION_COLUMNS = `
  id, space_id, group_id, parent_run_id, child_run_id, request_message_id,
  requesting_agent_id, target_agent_id, requested_by_user_id,
  policy_decision_record_id, status, instruction, reason, budget_json,
  context_policy_json, result_summary, tool_call_id, created_at, updated_at,
  completed_at
`;

export class PgAgentGroupRepository {
  constructor(private readonly db: Queryable) {}

  async canReadProject(
    spaceId: string,
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    return canReadProject(this.db, spaceId, projectId, userId);
  }

  async createGroup(input: {
    space_id: string;
    manager_user_id: string;
    manager_agent_id: string;
    room_id?: string | null;
    session_id?: string | null;
    trigger_message_id?: string | null;
    project_id?: string | null;
    project_folder_id?: string | null;
    title: string;
    goal: string;
    budget_json?: Record<string, unknown> | null;
    policy_snapshot_json?: Record<string, unknown> | null;
    now?: string;
  }): Promise<AgentRunGroupRecord> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<AgentRunGroupRecord>(
      `INSERT INTO agent_run_groups (
         id, space_id, root_run_id, manager_user_id, manager_agent_id, room_id,
         session_id, trigger_message_id, project_id, project_folder_id, title, goal, status,
         budget_json, policy_snapshot_json, created_at, updated_at
       ) VALUES (
         $1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active',
         $12::jsonb, $13::jsonb, $14, $14
       )
       RETURNING ${GROUP_COLUMNS}`,
      [
        randomUUID(),
        input.space_id,
        input.manager_user_id,
        input.manager_agent_id,
        input.room_id ?? null,
        input.session_id ?? null,
        input.trigger_message_id ?? null,
        input.project_id ?? null,
        input.project_folder_id ?? null,
        input.title,
        input.goal,
        JSON.stringify(input.budget_json ?? {}),
        JSON.stringify(input.policy_snapshot_json ?? {}),
        now,
      ],
    );
    return requiredRow(result.rows[0], "agent_run_groups insert returned no row");
  }

  async updateGroupRootRun(input: {
    space_id: string;
    group_id: string;
    root_run_id: string;
    now?: string;
  }): Promise<AgentRunGroupRecord> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<AgentRunGroupRecord>(
      `UPDATE agent_run_groups
          SET root_run_id = $3,
              updated_at = $4
        WHERE space_id = $1 AND id = $2
        RETURNING ${GROUP_COLUMNS}`,
      [input.space_id, input.group_id, input.root_run_id, now],
    );
    return requiredRow(result.rows[0], "agent_run_groups root update returned no row");
  }

  async updateGroupDetails(input: {
    space_id: string;
    group_id: string;
    title?: string | null;
    goal?: string | null;
    now?: string;
  }): Promise<AgentRunGroupRecord | null> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<AgentRunGroupRecord>(
      `UPDATE agent_run_groups
          SET title = COALESCE($3, title),
              goal = COALESCE($4, goal),
              updated_at = $5
        WHERE space_id = $1 AND id = $2
        RETURNING ${GROUP_COLUMNS}`,
      [
        input.space_id,
        input.group_id,
        input.title ?? null,
        input.goal ?? null,
        now,
      ],
    );
    return result.rows[0] ?? null;
  }

  async updateGroupStatus(input: {
    space_id: string;
    group_id: string;
    status: "active" | "paused" | "cancelled";
    now?: string;
  }): Promise<AgentRunGroupRecord | null> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<AgentRunGroupRecord>(
      `UPDATE agent_run_groups
          SET status = $3::varchar(32),
              updated_at = $4,
              ended_at = CASE WHEN $3::varchar(32) = 'cancelled' THEN $4 ELSE ended_at END
        WHERE space_id = $1
          AND id = $2
          AND status IN ('active', 'paused')
        RETURNING ${GROUP_COLUMNS}`,
      [input.space_id, input.group_id, input.status, now],
    );
    return result.rows[0] ?? null;
  }

  async getGroup(spaceId: string, groupId: string): Promise<AgentRunGroupRecord | null> {
    const result = await this.db.query<AgentRunGroupRecord>(
      `SELECT ${GROUP_COLUMNS}
         FROM agent_run_groups
        WHERE space_id = $1 AND id = $2`,
      [spaceId, groupId],
    );
    return result.rows[0] ?? null;
  }

  async lockGroup(spaceId: string, groupId: string): Promise<AgentRunGroupRecord | null> {
    const result = await this.db.query<AgentRunGroupRecord>(
      `SELECT ${GROUP_COLUMNS}
         FROM agent_run_groups
        WHERE space_id = $1 AND id = $2
        FOR UPDATE`,
      [spaceId, groupId],
    );
    return result.rows[0] ?? null;
  }

  async isActiveRoomUser(
    spaceId: string,
    roomId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM room_user_members room_member
           JOIN rooms room
             ON room.id = room_member.room_id
            AND room.space_id = room_member.space_id
           JOIN projects project
             ON project.id = room.project_id
            AND project.space_id = room.space_id
            AND project.deleted_at IS NULL
           JOIN spaces space
             ON space.id = project.space_id
           LEFT JOIN project_members project_member
             ON project_member.space_id = project.space_id
            AND project_member.project_id = project.id
            AND project_member.user_id = $3
            AND project_member.status = 'active'
          WHERE room_member.space_id = $1
            AND room_member.room_id = $2
            AND room_member.user_id = $3
            AND room_member.status = 'active'
            AND room.status = 'active'
            AND (
              space.type = 'personal'
              OR project.owner_user_id = $3
              OR project_member.user_id IS NOT NULL
            )
       ) AS allowed`,
      [spaceId, roomId, userId],
    );
    return result.rows[0]?.allowed === true;
  }

  async listActiveRoomUserIds(spaceId: string, roomId: string): Promise<string[]> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT user_id
         FROM room_user_members
        WHERE space_id = $1
          AND room_id = $2
          AND status = 'active'
        ORDER BY created_at ASC, id ASC`,
      [spaceId, roomId],
    );
    return result.rows.map((row) => row.user_id);
  }

  async listGroups(input: {
    space_id: string;
    manager_user_id: string;
    status?: string | null;
    limit: number;
    offset: number;
  }): Promise<AgentRunGroupRecord[]> {
    const params: unknown[] = [input.space_id, input.manager_user_id];
    const clauses = [
      "agent_run_groups.space_id = $1",
      "agent_run_groups.manager_user_id = $2",
      `(agent_run_groups.project_id IS NULL OR ${projectReadAccessSql(
        "agent_run_groups.space_id",
        "agent_run_groups.project_id",
        "$2",
      )})`,
    ];
    if (input.status) {
      params.push(input.status);
      clauses.push(`agent_run_groups.status = $${params.length}`);
    }
    params.push(input.limit, input.offset);
    const result = await this.db.query<AgentRunGroupRecord>(
      `SELECT ${GROUP_COLUMNS}
         FROM agent_run_groups
        WHERE ${clauses.join(" AND ")}
        ORDER BY agent_run_groups.updated_at DESC, agent_run_groups.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows;
  }

  async countGroups(input: {
    space_id: string;
    manager_user_id: string;
    status?: string | null;
  }): Promise<number> {
    const params: unknown[] = [input.space_id, input.manager_user_id];
    const clauses = [
      "agent_run_groups.space_id = $1",
      "agent_run_groups.manager_user_id = $2",
      `(agent_run_groups.project_id IS NULL OR ${projectReadAccessSql(
        "agent_run_groups.space_id",
        "agent_run_groups.project_id",
        "$2",
      )})`,
    ];
    if (input.status) {
      params.push(input.status);
      clauses.push(`agent_run_groups.status = $${params.length}`);
    }
    const result = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_run_groups
        WHERE ${clauses.join(" AND ")}`,
      params,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async createMember(input: {
    space_id: string;
    group_id: string;
    agent_id: string;
    role: string;
    capabilities_json?: Record<string, unknown> | null;
    context_policy_json?: Record<string, unknown> | null;
    now?: string;
  }): Promise<AgentRunGroupMemberRecord> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<AgentRunGroupMemberRecord>(
      `INSERT INTO agent_run_group_members (
         id, space_id, group_id, agent_id, role, status, capabilities_json,
         context_policy_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'active', $6::jsonb, $7::jsonb, $8, $8
       )
       RETURNING ${MEMBER_COLUMNS}`,
      [
        randomUUID(),
        input.space_id,
        input.group_id,
        input.agent_id,
        input.role,
        JSON.stringify(input.capabilities_json ?? {}),
        JSON.stringify(input.context_policy_json ?? {}),
        now,
      ],
    );
    return requiredRow(result.rows[0], "agent_run_group_members insert returned no row");
  }

  /**
   * The manager leads, then insertion order.
   *
   * `created_at, id` alone was not deterministic: a group's members are
   * inserted in one transaction and share a timestamp, so the tiebreak fell
   * to a random UUID and the same data came back in either order — which
   * surfaced as a test that failed roughly one run in nine.
   */
  async listMembers(spaceId: string, groupId: string): Promise<AgentRunGroupMemberRecord[]> {
    const result = await this.db.query<AgentRunGroupMemberRecord>(
      `SELECT ${MEMBER_COLUMNS}
         FROM agent_run_group_members
        WHERE space_id = $1 AND group_id = $2
        ORDER BY (role <> 'manager'), created_at ASC, id ASC`,
      [spaceId, groupId],
    );
    return result.rows;
  }

  async getMemberWithAgentStatus(input: {
    space_id: string;
    group_id: string;
    agent_id: string;
    user_id: string;
  }): Promise<AgentRunGroupMemberWithAgentStatus | null> {
    const result = await this.db.query<AgentRunGroupMemberWithAgentStatus>(
      `SELECT ${MEMBER_COLUMNS_ALIASED},
              a.status AS agent_status,
              a.agent_kind
         FROM agent_run_group_members m
         JOIN agent_run_groups group_row
           ON group_row.space_id = m.space_id AND group_row.id = m.group_id
         JOIN agents a
           ON a.space_id = m.space_id
          AND a.id = m.agent_id
        WHERE m.space_id = $1 AND m.group_id = $2 AND m.agent_id = $3
          AND (
            group_row.room_id IS NULL
            OR EXISTS (
              SELECT 1
                FROM rooms room_scope
                JOIN room_agent_members room_agent_member
                  ON room_agent_member.space_id = room_scope.space_id
                 AND room_agent_member.room_id = room_scope.id
                 AND room_agent_member.agent_id = m.agent_id
                 AND room_agent_member.status = 'active'
               WHERE room_scope.space_id = group_row.space_id
                 AND room_scope.id = group_row.room_id
                 AND room_scope.status = 'active'
            )
          )
          AND (
            group_row.room_id IS NULL
            OR EXISTS (
              SELECT 1
                FROM rooms room_project_scope
               WHERE room_project_scope.space_id = group_row.space_id
                 AND room_project_scope.id = group_row.room_id
                 AND ${projectReadAccessSql("room_project_scope.space_id", "room_project_scope.project_id", "$4")}
            )
          )
          AND (
            group_row.room_id IS NULL
            OR EXISTS (
              SELECT 1
                FROM room_user_members room_user
               WHERE room_user.space_id = group_row.space_id
                 AND room_user.room_id = group_row.room_id
                 AND room_user.user_id = $4
                 AND room_user.status = 'active'
            )
          )
          AND (
            ${contentReadSql("agent", "a", "$4")}
            OR (
              group_row.room_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM room_agent_access_grants room_grant
                  JOIN room_user_members room_member
                    ON room_member.space_id = room_grant.space_id
                   AND room_member.room_id = room_grant.room_id
                   AND room_member.user_id = $4
                   AND room_member.status = 'active'
                 WHERE a.visibility <> 'space_shared'
                   AND room_grant.space_id = a.space_id
                   AND room_grant.room_id = group_row.room_id
                   AND room_grant.agent_id = a.id
                   AND room_grant.grantee_user_id = $4
                   AND room_grant.revoked_at IS NULL
              )
            )
          )`,
      [input.space_id, input.group_id, input.agent_id, input.user_id],
    );
    return result.rows[0] ?? null;
  }

  async listAgentStatuses(spaceId: string, userId: string, agentIds: readonly string[], roomId?: string | null): Promise<AgentStatusRecord[]> {
    if (agentIds.length === 0) return [];
    const result = await this.db.query<AgentStatusRecord>(
      `SELECT a.id, a.status, a.agent_kind
         FROM agents a
        WHERE a.space_id = $1 AND a.id = ANY($3::varchar[])
          AND (
            $4::varchar IS NULL
            OR EXISTS (
              SELECT 1
                FROM rooms room_scope
                JOIN room_agent_members room_agent_member
                  ON room_agent_member.space_id = room_scope.space_id
                 AND room_agent_member.room_id = room_scope.id
                 AND room_agent_member.agent_id = a.id
                 AND room_agent_member.status = 'active'
               WHERE room_scope.space_id = a.space_id
                 AND room_scope.id = $4
                 AND room_scope.status = 'active'
            )
          )
          AND (
            $4::varchar IS NULL
            OR EXISTS (
              SELECT 1
                FROM rooms room_project_scope
               WHERE room_project_scope.space_id = a.space_id
                 AND room_project_scope.id = $4
                 AND ${projectReadAccessSql("room_project_scope.space_id", "room_project_scope.project_id", "$2")}
            )
          )
          AND (
            $4::varchar IS NULL
            OR EXISTS (
              SELECT 1
                FROM room_user_members room_user
               WHERE room_user.space_id = a.space_id
                 AND room_user.room_id = $4
                 AND room_user.user_id = $2
                 AND room_user.status = 'active'
            )
          )
          AND (
            ${contentReadSql("agent", "a", "$2")}
            OR (
              $4::varchar IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM room_agent_access_grants room_grant
                  JOIN room_user_members room_member
                    ON room_member.space_id = room_grant.space_id
                   AND room_member.room_id = room_grant.room_id
                   AND room_member.user_id = $2
                   AND room_member.status = 'active'
                 WHERE a.visibility <> 'space_shared'
                   AND room_grant.space_id = a.space_id
                   AND room_grant.room_id = $4
                   AND room_grant.agent_id = a.id
                   AND room_grant.grantee_user_id = $2
                   AND room_grant.revoked_at IS NULL
              )
            )
          )`,
      [spaceId, userId, agentIds, roomId ?? null],
    );
    return result.rows;
  }

  async listAgentCapabilitySnapshots(
    spaceId: string,
    userId: string,
    agentIds: readonly string[],
    roomId?: string | null,
  ): Promise<AgentCapabilitySnapshotRecord[]> {
    const ids = [...new Set(agentIds.filter((id) => id.trim().length > 0))];
    if (ids.length === 0) return [];
    const result = await this.db.query<AgentCapabilitySnapshotRecord>(
      `SELECT a.id,
              COALESCE(NULLIF(a.name, ''), a.id) AS name,
              a.description,
              a.role_instruction,
              COALESCE(av.capabilities_json, '[]'::jsonb) AS capabilities_json
         FROM agents a
         LEFT JOIN agent_versions av
           ON av.id = a.current_version_id
          AND av.space_id = a.space_id
          AND av.agent_id = a.id
        WHERE a.space_id = $1 AND a.id = ANY($3::varchar[])
          AND (
            $4::varchar IS NULL
            OR EXISTS (
              SELECT 1
                FROM rooms room_scope
                JOIN room_agent_members room_agent_member
                  ON room_agent_member.space_id = room_scope.space_id
                 AND room_agent_member.room_id = room_scope.id
                 AND room_agent_member.agent_id = a.id
                 AND room_agent_member.status = 'active'
               WHERE room_scope.space_id = a.space_id
                 AND room_scope.id = $4
                 AND room_scope.status = 'active'
            )
          )
          AND (
            $4::varchar IS NULL
            OR EXISTS (
              SELECT 1
                FROM rooms room_project_scope
               WHERE room_project_scope.space_id = a.space_id
                 AND room_project_scope.id = $4
                 AND ${projectReadAccessSql("room_project_scope.space_id", "room_project_scope.project_id", "$2")}
            )
          )
          AND (
            $4::varchar IS NULL
            OR EXISTS (
              SELECT 1
                FROM room_user_members room_user
               WHERE room_user.space_id = a.space_id
                 AND room_user.room_id = $4
                 AND room_user.user_id = $2
                 AND room_user.status = 'active'
            )
          )
          AND (
            ${contentReadSql("agent", "a", "$2")}
            OR (
              $4::varchar IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM room_agent_access_grants room_grant
                  JOIN room_user_members room_member
                    ON room_member.space_id = room_grant.space_id
                   AND room_member.room_id = room_grant.room_id
                   AND room_member.user_id = $2
                   AND room_member.status = 'active'
                 WHERE a.visibility <> 'space_shared'
                   AND room_grant.space_id = a.space_id
                   AND room_grant.room_id = $4
                   AND room_grant.agent_id = a.id
                   AND room_grant.grantee_user_id = $2
                   AND room_grant.revoked_at IS NULL
              )
            )
          )`,
      [spaceId, userId, ids, roomId ?? null],
    );
    return result.rows;
  }

  async createMessage(input: {
    space_id: string;
    group_id: string;
    run_id?: string | null;
    parent_message_id?: string | null;
    sender_actor_ref_json: Record<string, unknown>;
    sender_user_id?: string | null;
    sender_agent_id?: string | null;
    message_type: string;
    content: string;
    mentions_json?: unknown[] | null;
    metadata_json?: Record<string, unknown> | null;
    now?: string;
  }): Promise<AgentRunMessageRecord> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<AgentRunMessageRecord>(
      `INSERT INTO agent_run_messages (
         id, space_id, group_id, run_id, parent_message_id, sender_actor_ref_json,
         sender_user_id, sender_agent_id, message_type, content, mentions_json,
         metadata_json, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13
       )
       RETURNING ${MESSAGE_COLUMNS}`,
      [
        randomUUID(),
        input.space_id,
        input.group_id,
        input.run_id ?? null,
        input.parent_message_id ?? null,
        JSON.stringify(input.sender_actor_ref_json),
        input.sender_user_id ?? null,
        input.sender_agent_id ?? null,
        input.message_type,
        input.content,
        JSON.stringify(input.mentions_json ?? []),
        JSON.stringify(input.metadata_json ?? {}),
        now,
      ],
    );
    return requiredRow(result.rows[0], "agent_run_messages insert returned no row");
  }

  async listMessages(input: {
    space_id: string;
    group_id: string;
    limit: number;
    offset: number;
  }): Promise<AgentRunMessageRecord[]> {
    const result = await this.db.query<AgentRunMessageRecord>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM agent_run_messages
        WHERE space_id = $1 AND group_id = $2
        ORDER BY created_at ASC, id ASC
        LIMIT $3 OFFSET $4`,
      [input.space_id, input.group_id, input.limit, input.offset],
    );
    return result.rows;
  }

  async getMessage(spaceId: string, messageId: string): Promise<AgentRunMessageRecord | null> {
    const result = await this.db.query<AgentRunMessageRecord>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM agent_run_messages
        WHERE space_id = $1 AND id = $2`,
      [spaceId, messageId],
    );
    return result.rows[0] ?? null;
  }

  async findTurnParentMessageIdForRun(input: {
    space_id: string;
    group_id: string;
    run_id: string;
  }): Promise<string | null> {
    const result = await this.db.query<{ parent_message_id: string | null }>(
      `WITH user_message AS (
          SELECT id
            FROM agent_run_messages
           WHERE space_id = $1
             AND group_id = $2
             AND run_id::text = $3::text
             AND message_type = 'user_instruction'
           ORDER BY created_at ASC, id ASC
           LIMIT 1
        ),
        linked_message AS (
          SELECT parent_message_id
            FROM agent_run_messages
           WHERE space_id = $1
             AND group_id = $2
             AND run_id::text = $3::text
             AND parent_message_id IS NOT NULL
           ORDER BY created_at ASC, id ASC
           LIMIT 1
        ),
        multi_recipient_message AS (
          SELECT id
            FROM agent_run_messages
           WHERE space_id = $1
             AND group_id = $2
             AND message_type = 'user_instruction'
             AND (
               metadata_json->>'recipient_run_id' = $3::text
               OR metadata_json->'recipient_run_ids' ? $3::text
             )
           ORDER BY created_at ASC, id ASC
           LIMIT 1
        ),
        any_message AS (
          SELECT id
            FROM agent_run_messages
           WHERE space_id = $1
             AND group_id = $2
             AND run_id::text = $3::text
           ORDER BY created_at ASC, id ASC
           LIMIT 1
        )
        SELECT COALESCE(
          (SELECT id FROM user_message),
          (SELECT parent_message_id FROM linked_message),
          (SELECT id FROM multi_recipient_message),
          (SELECT id FROM any_message)
        ) AS parent_message_id`,
      [input.space_id, input.group_id, input.run_id],
    );
    return result.rows[0]?.parent_message_id ?? null;
  }

  async hasAgentMessageForRun(input: {
    space_id: string;
    group_id: string;
    run_id: string;
  }): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id
         FROM agent_run_messages
        WHERE space_id = $1
          AND group_id = $2
          AND run_id = $3
          AND message_type = 'agent_message'
        LIMIT 1`,
      [input.space_id, input.group_id, input.run_id],
    );
    return result.rows.length > 0;
  }

  async createDelegation(input: {
    space_id: string;
    group_id: string;
    parent_run_id: string;
    request_message_id?: string | null;
    requesting_agent_id: string;
    target_agent_id: string;
    requested_by_user_id?: string | null;
    instruction: string;
    reason?: string | null;
    budget_json?: Record<string, unknown> | null;
    context_policy_json?: Record<string, unknown> | null;
    tool_call_id?: string | null;
    now?: string;
  }): Promise<RunDelegationRecord> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<RunDelegationRecord>(
      `INSERT INTO run_delegations (
         id, space_id, group_id, parent_run_id, child_run_id,
         request_message_id, requesting_agent_id, target_agent_id,
         requested_by_user_id, policy_decision_record_id, status, instruction,
         reason, budget_json, context_policy_json, result_summary, tool_call_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, NULL, $5, $6, $7, $8, NULL, 'requested', $9,
         $10, $11::jsonb, $12::jsonb, NULL, $13, $14, $14
       )
       RETURNING ${DELEGATION_COLUMNS}`,
      [
        randomUUID(),
        input.space_id,
        input.group_id,
        input.parent_run_id,
        input.request_message_id ?? null,
        input.requesting_agent_id,
        input.target_agent_id,
        input.requested_by_user_id ?? null,
        input.instruction,
        input.reason ?? null,
        JSON.stringify(input.budget_json ?? {}),
        JSON.stringify(input.context_policy_json ?? {}),
        input.tool_call_id ?? null,
        now,
      ],
    );
    return requiredRow(result.rows[0], "run_delegations insert returned no row");
  }

  async findDelegationByToolCallId(
    space_id: string,
    parent_run_id: string,
    tool_call_id: string,
  ): Promise<RunDelegationRecord | null> {
    const result = await this.db.query<RunDelegationRecord>(
      `SELECT ${DELEGATION_COLUMNS}
         FROM run_delegations
        WHERE space_id = $1 AND parent_run_id = $2 AND tool_call_id = $3`,
      [space_id, parent_run_id, tool_call_id],
    );
    return result.rows[0] ?? null;
  }

  async updateDelegationAfterPolicy(input: {
    space_id: string;
    delegation_id: string;
    status: "policy_denied" | "queued";
    child_run_id?: string | null;
    policy_decision_record_id?: string | null;
    now?: string;
  }): Promise<RunDelegationRecord> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<RunDelegationRecord>(
      `UPDATE run_delegations
          SET status = $3::varchar(32),
              child_run_id = $4,
              policy_decision_record_id = $5,
              updated_at = $6,
              completed_at = CASE WHEN $3::varchar(32) = 'policy_denied' THEN $6 ELSE completed_at END
        WHERE space_id = $1 AND id = $2
        RETURNING ${DELEGATION_COLUMNS}`,
      [
        input.space_id,
        input.delegation_id,
        input.status,
        input.child_run_id ?? null,
        input.policy_decision_record_id ?? null,
        now,
      ],
    );
    return requiredRow(result.rows[0], "run_delegations update returned no row");
  }

  async getDelegationForChildRun(input: {
    space_id: string;
    delegation_id: string;
    child_run_id: string;
  }): Promise<RunDelegationRecord | null> {
    const result = await this.db.query<RunDelegationRecord>(
      `SELECT ${DELEGATION_COLUMNS}
         FROM run_delegations
        WHERE space_id = $1 AND id = $2 AND child_run_id = $3`,
      [input.space_id, input.delegation_id, input.child_run_id],
    );
    return result.rows[0] ?? null;
  }

  async markDelegationRunning(input: {
    space_id: string;
    delegation_id: string;
    child_run_id: string;
    now?: string;
  }): Promise<RunDelegationLifecycleUpdateResult> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<RunDelegationRecord>(
      `UPDATE run_delegations
          SET status = 'running',
              updated_at = $4
        WHERE space_id = $1
          AND id = $2
          AND child_run_id = $3
          AND status = 'queued'
        RETURNING ${DELEGATION_COLUMNS}`,
      [input.space_id, input.delegation_id, input.child_run_id, now],
    );
    const delegation = result.rows[0] ?? await this.getDelegationForChildRun({
      space_id: input.space_id,
      delegation_id: input.delegation_id,
      child_run_id: input.child_run_id,
    });
    return { delegation, changed: result.rows.length > 0 };
  }

  async markDelegationTerminal(input: {
    space_id: string;
    delegation_id: string;
    child_run_id: string;
    status: "succeeded" | "failed" | "cancelled";
    result_summary: string;
    now?: string;
  }): Promise<RunDelegationLifecycleUpdateResult> {
    const now = input.now ?? new Date().toISOString();
    const result = await this.db.query<RunDelegationRecord>(
      `UPDATE run_delegations
          SET status = $4,
              result_summary = $5,
              updated_at = $6,
              completed_at = $6
        WHERE space_id = $1
          AND id = $2
          AND child_run_id = $3
          AND status IN ('queued', 'running')
        RETURNING ${DELEGATION_COLUMNS}`,
      [
        input.space_id,
        input.delegation_id,
        input.child_run_id,
        input.status,
        input.result_summary,
        now,
      ],
    );
    const delegation = result.rows[0] ?? await this.getDelegationForChildRun({
      space_id: input.space_id,
      delegation_id: input.delegation_id,
      child_run_id: input.child_run_id,
    });
    return { delegation, changed: result.rows.length > 0 };
  }

  async listDelegations(spaceId: string, groupId: string): Promise<RunDelegationRecord[]> {
    const result = await this.db.query<RunDelegationRecord>(
      `SELECT ${DELEGATION_COLUMNS}
         FROM run_delegations
        WHERE space_id = $1 AND group_id = $2
        ORDER BY created_at ASC, id ASC`,
      [spaceId, groupId],
    );
    return result.rows;
  }

  async listDelegationsForParent(input: {
    space_id: string;
    parent_run_id: string;
  }): Promise<RunDelegationRecord[]> {
    const result = await this.db.query<RunDelegationRecord>(
      `SELECT ${DELEGATION_COLUMNS}
         FROM run_delegations
        WHERE space_id = $1 AND parent_run_id = $2
        ORDER BY created_at ASC, id ASC`,
      [input.space_id, input.parent_run_id],
    );
    return result.rows;
  }

  async countDelegationsForParent(input: {
    space_id: string;
    parent_run_id: string;
  }): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM run_delegations
        WHERE space_id = $1 AND parent_run_id = $2`,
      [input.space_id, input.parent_run_id],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countActiveDelegationsForGroup(input: {
    space_id: string;
    group_id: string;
  }): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM run_delegations d
         LEFT JOIN runs r
           ON r.space_id = d.space_id
          AND r.id = d.child_run_id
        WHERE d.space_id = $1
          AND d.group_id = $2
          AND (
            d.status = 'requested'
            OR r.status IN ('queued', 'running', 'waiting_for_review')
          )`,
      [input.space_id, input.group_id],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async runDepth(input: { space_id: string; run_id: string }): Promise<number> {
    const result = await this.db.query<{ depth: string }>(
      `WITH RECURSIVE lineage(id, parent_run_id, depth) AS (
         SELECT id, parent_run_id, 0
           FROM runs
          WHERE space_id = $1 AND id = $2
         UNION ALL
         SELECT parent.id, parent.parent_run_id, lineage.depth + 1
           FROM runs parent
           JOIN lineage ON lineage.parent_run_id = parent.id
          WHERE parent.space_id = $1
       )
       SELECT COALESCE(MAX(depth), 0)::text AS depth FROM lineage`,
      [input.space_id, input.run_id],
    );
    return Number(result.rows[0]?.depth ?? 0);
  }

  async listRunIdsForGroup(spaceId: string, groupId: string, userId: string): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id
         FROM runs r
        WHERE r.space_id = $1 AND r.run_group_id = $2
          AND ${contentReadSql("run", "r", "$3")}
        ORDER BY r.created_at ASC, r.id ASC`,
      [spaceId, groupId, userId],
    );
    return result.rows.map((row) => row.id);
  }

  async listArtifactIdsForRuns(spaceId: string, userId: string, runIds: readonly string[]): Promise<string[]> {
    if (runIds.length === 0) return [];
    const result = await this.db.query<{ id: string }>(
      `SELECT id
         FROM artifacts a
        WHERE a.space_id = $1 AND a.run_id = ANY($3::varchar[])
          AND ${contentReadSql("artifact", "a", "$2")}
        ORDER BY a.created_at ASC, a.id ASC`,
      [spaceId, userId, runIds],
    );
    return result.rows.map((row) => row.id);
  }

  async listProposalIdsForRuns(spaceId: string, userId: string, runIds: readonly string[]): Promise<string[]> {
    if (runIds.length === 0) return [];
    const result = await this.db.query<{ id: string }>(
      `SELECT id
         FROM proposals p
        WHERE p.space_id = $1 AND p.created_by_run_id = ANY($3::varchar[])
          AND ${contentReadSql("proposal", "p", "$2")}
        ORDER BY p.created_at ASC, p.id ASC`,
      [spaceId, userId, runIds],
    );
    return result.rows.map((row) => row.id);
  }

  async listPolicyDecisionRecordIdsForGroup(spaceId: string, groupId: string): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(
      `SELECT DISTINCT policy_decision_record_id AS id
         FROM run_delegations
        WHERE space_id = $1
          AND group_id = $2
          AND policy_decision_record_id IS NOT NULL
        ORDER BY id ASC`,
      [spaceId, groupId],
    );
    return result.rows.map((row) => row.id);
  }
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}
