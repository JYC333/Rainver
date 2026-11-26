import { contentReadSql, projectReadAccessSql } from "../access/contentAccessSql.js";
import { lockProjectAudience } from "../projects/access.js";
import type { Queryable } from "../routeUtils/common.js";

/**
 * The synchronization boundary a decision resting on `roomAgentUseSql` takes,
 * in this order: the Project audience (Project row, its membership, people and
 * Space memberships `FOR SHARE`), then the Room row `FOR SHARE`. Room writers
 * that withdraw execution authority hold the Room row (`FOR NO KEY UPDATE` or
 * `FOR UPDATE`) and Project membership writers the Project
 * (`lockProjectAudienceForChange`), so each either commits before the decision
 * or waits for it. Ask the predicate in a later statement: under READ
 * COMMITTED it then reads a snapshot taken after these locks, not one taken
 * while it waited. Run claim (`claimRunExecution`), plugin entry/release
 * (`plugins/projectBindings.ts`) and a plugin companion Agent's command
 * (`plugins/agentRoleAdmission.ts`) share it.
 *
 * The same order, Project before Room, binds the Room writers: an Agent's
 * command holds its Project `FOR UPDATE` before it reaches this Room lock, and
 * a Room writer's first Agent add inserts a `project_agent_links` row whose
 * foreign key takes the Project `FOR KEY SHARE`, as does any other Project-scoped
 * row a Room write inserts. So every locked Room read (`PgRoomRepository`,
 * `lockRoomProjectKey`) takes that Project key lock before the Room row, never
 * after it.
 */
export async function lockRoomExecutionAuthority(db: Queryable, spaceId: string, projectId: string | null, roomId: string): Promise<void> {
  if (projectId) await lockProjectAudience(db, spaceId, projectId);
  await db.query("SELECT id FROM rooms WHERE space_id=$1 AND id=$2 FOR SHARE", [spaceId, roomId]);
}

/**
 * Where a Run executes, the one resolution every Room execution decision uses
 * (Run claim, a plugin companion Agent's admission, a cross-Project plugin
 * entry): the Room is its Run Group's, else its conversation's; the
 * conversation whose audience bounds it is its own, else its Run Group's. A
 * Run with neither has no Room. Takes the Run's fields, so a proposed Run not
 * yet stored resolves the same way.
 */
export async function runExecutionPlacement(
  db: Queryable,
  spaceId: string,
  run: { run_group_id?: string | null; session_id?: string | null },
): Promise<{ room_id: string | null; session_id: string | null }> {
  const row = (await db.query<{ room_id: string | null; session_id: string | null }>(
    `SELECT COALESCE(g.room_id, s.room_id) AS room_id, COALESCE($3::varchar, g.session_id) AS session_id
       FROM (SELECT 1) one
       LEFT JOIN agent_run_groups g ON g.id = $2::varchar AND g.space_id = $1
       LEFT JOIN sessions s ON s.id = COALESCE($3::varchar, g.session_id) AND s.space_id = $1`,
    [spaceId, run.run_group_id ?? null, run.session_id ?? null],
  )).rows[0];
  return { room_id: row?.room_id ?? null, session_id: row?.session_id ?? null };
}

/**
 * Execution-only authority. This predicate must never authorize Agent content reads.
 *
 * `anyAgentStatus` drops only the Agent's own `active` condition, for the one
 * listing that keeps a stopped Agent visible to the people its Rooms still
 * admit (`agents/myAgents.ts`): every Room, membership, Project and grant
 * condition stays. It never decides execution.
 */
export function roomAgentUseSql(agent: string, user: string, room: string, options: { anyAgentStatus?: boolean } = {}): string {
  return `EXISTS (
    SELECT 1 FROM rooms usage_room
    JOIN room_agent_members usage_agent ON usage_agent.space_id=usage_room.space_id
      AND usage_agent.room_id=usage_room.id AND usage_agent.agent_id=${agent}.id AND usage_agent.status='active'
    JOIN room_user_members usage_user ON usage_user.space_id=usage_room.space_id
      AND usage_user.room_id=usage_room.id AND usage_user.user_id=${user} AND usage_user.status='active'
    WHERE usage_room.id=${room} AND usage_room.space_id=${agent}.space_id AND usage_room.status='active'
      ${options.anyAgentStatus ? "" : `AND ${agent}.status='active'`}
      AND EXISTS (SELECT 1 FROM space_memberships usage_space_member
        WHERE usage_space_member.space_id=${agent}.space_id AND usage_space_member.user_id=${user}
          AND usage_space_member.status='active')
      AND (${agent}.project_id IS NULL OR ${agent}.project_id=usage_room.project_id)
      AND ${projectReadAccessSql("usage_room.space_id", "usage_room.project_id", user)}
      AND (((${agent}.access_project_id IS NULL OR ${agent}.access_project_id=usage_room.project_id)
        AND ${contentReadSql("agent", agent, user, { includeOversight: false })})
        OR EXISTS (SELECT 1 FROM room_agent_access_grants usage_grant
          WHERE usage_grant.space_id=${agent}.space_id AND usage_grant.room_id=usage_room.id
            AND usage_grant.agent_id=${agent}.id AND usage_grant.grantee_user_id=${user}
            AND ${effectiveRoomAgentGrantSql(agent, "usage_grant", "usage_room")}))
  )`;
}

/** The live grant predicate shared by execution and both roster projections. */
export function effectiveRoomAgentGrantSql(agent: string, grant: string, room: string): string {
  return `${grant}.granted_by_user_id=${agent}.owner_user_id AND ${grant}.revoked_at IS NULL
    AND ${roomAgentGrantIssuerSql(agent, room)}`;
}

/** Cross-Project use requires the current owner's live Room/Project management. */
export function roomAgentGrantIssuerSql(agent: string, room: string): string {
  return `(${agent}.access_project_id IS NULL OR ${agent}.access_project_id=${room}.project_id
      OR EXISTS (SELECT 1 FROM room_user_members issuer_room
        JOIN space_memberships issuer_space ON issuer_space.space_id=issuer_room.space_id
          AND issuer_space.user_id=issuer_room.user_id AND issuer_space.status='active'
        JOIN users issuer ON issuer.id=issuer_room.user_id AND issuer.status='active'
        JOIN projects issuer_project ON issuer_project.space_id=issuer_room.space_id
          AND issuer_project.id=${room}.project_id AND issuer_project.deleted_at IS NULL AND issuer_project.status='active'
        WHERE issuer_room.space_id=${room}.space_id AND issuer_room.room_id=${room}.id
          AND issuer_room.user_id=${agent}.owner_user_id AND issuer_room.status='active'
          AND ${projectReadAccessSql(`${room}.space_id`, `${room}.project_id`, `${agent}.owner_user_id`)}
          AND (issuer_project.owner_user_id=issuer.id OR issuer_space.role IN ('owner','admin')
            OR EXISTS (SELECT 1 FROM project_members issuer_member
              WHERE issuer_member.space_id=${room}.space_id AND issuer_member.project_id=${room}.project_id
                AND issuer_member.user_id=issuer.id AND issuer_member.status='active'
                AND issuer_member.role IN ('owner','member')))))`;
}

/** Live admission only. A stored Run snapshot does not enroll a removed Agent
 * in future turns; already-running turns retain their immutable snapshot. */
export function conversationAgentParticipatesSql(space: string, session: string, agent: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM sessions participant_session
    JOIN conversation_execution_contexts participant_context
      ON participant_context.space_id=participant_session.space_id
      AND participant_context.session_id=participant_session.id AND participant_context.state='initialized'
    WHERE participant_session.space_id=${space} AND participant_session.id=${session}
      AND participant_session.room_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM session_conversation_backends participant_binding
        WHERE participant_binding.space_id=participant_session.space_id
          AND participant_binding.session_id=participant_session.id
          AND participant_binding.agent_id=${agent} AND participant_binding.participating)
  )`;
}
