import { assertSqlIdentifier, projectReadAccessSql } from "../access/contentAccessSql.js";

/** The Session reader's source gate for aggregate projections. Run visibility
 * alone does not grant access to another person's direct conversation.
 */
export function attentionSessionReadSql(alias: string, user: string): string {
  assertSqlIdentifier(alias,"alias");
  return `${alias}.status='active'
    AND (${alias}.project_id IS NULL OR ${projectReadAccessSql(`${alias}.space_id`,`${alias}.project_id`,user)})
    AND ((${alias}.room_id IS NULL AND ${alias}.user_id=${user}) OR EXISTS (
      SELECT 1 FROM rooms session_room JOIN room_user_members session_member
        ON session_member.space_id=session_room.space_id AND session_member.room_id=session_room.id
        AND session_member.user_id=${user} AND session_member.status='active'
      WHERE session_room.id=${alias}.room_id AND session_room.space_id=${alias}.space_id AND session_room.status='active'
    ))`;
}
