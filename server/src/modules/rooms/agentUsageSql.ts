import { contentReadSql, projectReadAccessSql } from "../access/contentAccessSql.js";

/** Execution-only authority. This predicate must never authorize Agent content reads. */
export function roomAgentUseSql(agent: string, user: string, room: string): string {
  return `EXISTS (
    SELECT 1 FROM rooms usage_room
    JOIN room_agent_members usage_agent ON usage_agent.space_id=usage_room.space_id
      AND usage_agent.room_id=usage_room.id AND usage_agent.agent_id=${agent}.id AND usage_agent.status='active'
    JOIN room_user_members usage_user ON usage_user.space_id=usage_room.space_id
      AND usage_user.room_id=usage_room.id AND usage_user.user_id=${user} AND usage_user.status='active'
    WHERE usage_room.id=${room} AND usage_room.space_id=${agent}.space_id AND usage_room.status='active'
      AND ${agent}.status='active'
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
