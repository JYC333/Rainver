import type { Queryable } from "../routeUtils/common.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { roomAudience } from "./threadReferences.js";

/**
 * Conversation audience (`.agent/modules/rooms.md`, "Conversation audience").
 *
 * A Room is still the visibility boundary (ADR 0018), but its audience can
 * grow. When someone joins without being given the history, every existing
 * conversation keeps the audience it had: it is frozen to the people who could
 * read it until now (`room_conversation_audiences` +
 * `room_conversation_audience_members`), and a new conversation is opened that
 * the whole new audience reads. Nothing here is ever widened again — a later
 * invitation that shares history leaves an already-frozen conversation as it
 * is — and a member who leaves the Room loses a frozen conversation with the
 * Room, because every read ANDs the Room's own gate.
 *
 * Callers hold the Room lock (`FOR UPDATE` / `FOR NO KEY UPDATE`) that every
 * conversation creation and send takes, so no conversation or message can
 * slip between the snapshot and the membership change.
 */
export async function freezeConversationAudiences(
  db: Queryable,
  input: {
    spaceId: string;
    room: { id: string; project_id: string; is_mainline: boolean };
    invitationId: string;
  },
): Promise<{ frozenSessionIds: string[]; sharedConversationId: string | null }> {
  // Every conversation the bin can still return, not only the active list:
  // restoring one from Archived or the recycle bin must not reopen it to the
  // newcomer.
  const unfrozen = await db.query<{ id: string }>(
    `SELECT s.id
       FROM sessions s
      WHERE s.space_id = $1 AND s.room_id = $2
        AND s.status IN ('active', 'archived', 'deleted')
        AND NOT EXISTS (
          SELECT 1 FROM room_conversation_audiences frozen
           WHERE frozen.session_id = s.id AND frozen.space_id = s.space_id
        )
      ORDER BY s.id
      FOR UPDATE OF s`,
    [input.spaceId, input.room.id],
  );
  const sessionIds = unfrozen.rows.map((row) => row.id);
  if (!sessionIds.length) return { frozenSessionIds: [], sharedConversationId: null };
  // Who reads the Room now, as its read gate answers it (a mainline's audience
  // is every Project reader, not its enrolled roster).
  const audience = await roomAudience(db, input.spaceId, input.room);
  await db.query(
    `INSERT INTO room_conversation_audiences (
       session_id, space_id, room_id, project_id, frozen_by_invitation_id, created_at
     )
     SELECT s.id, s.space_id, s.room_id, s.project_id, $3, now()
       FROM sessions s
      WHERE s.space_id = $1 AND s.id = ANY($2::varchar[])`,
    [input.spaceId, sessionIds, input.invitationId],
  );
  if (audience.length) {
    await db.query(
      `INSERT INTO room_conversation_audience_members (space_id, session_id, user_id, created_at)
       SELECT $1, session_id, user_id, now()
         FROM unnest($2::varchar[]) AS session(session_id)
        CROSS JOIN unnest($3::varchar[]) AS person(user_id)`,
      [input.spaceId, sessionIds, audience],
    );
  }
  // The conversation the whole new audience continues in. A draft, like any
  // conversation opened by an explicit action (ADR 0018 decision 5): it holds
  // no message and no execution choice until someone opens it.
  const shared = await new PgSessionRepository(db).createRoomConversation({
    space_id: input.spaceId,
    room_id: input.room.id,
    project_id: input.room.project_id,
    project_folder_id: null,
    title: "Shared conversation",
    metadata: { execution_setup_started: true, opened_for_invitation_id: input.invitationId },
  });
  return { frozenSessionIds: sessionIds, sharedConversationId: shared.id };
}

/** The conversation an invitation's activation opened, if it opened one. */
export async function sharedConversationForInvitation(
  db: Queryable,
  spaceId: string,
  roomId: string,
  invitationId: string,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM sessions
      WHERE space_id = $1 AND room_id = $2
        AND metadata_json->>'opened_for_invitation_id' = $3
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [spaceId, roomId, invitationId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Who reads one conversation, for the people-facing label: the Room's current
 * audience, intersected with the conversation's own when it is frozen.
 */
export async function conversationAudienceSummary(
  db: Queryable,
  spaceId: string,
  room: { id: string; project_id: string; is_mainline: boolean },
  sessionId: string,
): Promise<{ restricted: boolean; user_ids: string[] }> {
  const frozen = await db.query(
    `SELECT 1 FROM room_conversation_audiences WHERE space_id = $1 AND session_id = $2`,
    [spaceId, sessionId],
  );
  return {
    restricted: Boolean(frozen.rows.length),
    user_ids: await roomAudience(db, spaceId, room, sessionId),
  };
}
