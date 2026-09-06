import type { Queryable } from "../routeUtils/common.js";
import { roomConversationReadAccessSql } from "../access/contentAccessSql.js";

/**
 * What an Agent is given back of its own Memory when it is dispatched
 * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §4).
 *
 * Two kinds, with different reach. The **persona** — one active entry per
 * Agent — is delivered everywhere, which is why it is free of Project facts by
 * rule. A **note** carries the Room it was learned in and is delivered only
 * where everyone who may read the current Room's conversations may also read
 * the origin Room's: an audience that could not have seen the conversation the
 * note came from never receives the note. A note taken in direct chat with the
 * owner has no origin Room and reaches only that direct chat.
 *
 * "May read" is asked of the read gate (`roomConversationReadAccessSql`), not
 * of the roster: a mainline's audience is every Project reader, of whom the
 * roster holds only those who have opened it, and a limited Room's is its
 * roster intersected with Project readability. Measuring by roster understated
 * the mainline — a note from a limited Room was delivered into a mainline
 * nobody but the owner had opened yet, and whoever opened it next read the
 * reply. The audience is enumerated over the Space's active members, which is
 * what `projectReaderIds` does for Thread References.
 *
 * The test is computed here, at dispatch, and not at write time: a Room whose
 * roster or Project changed must change what is delivered into it, and ADR
 * 0018 makes the *current* answer the answer. It runs inside the candidate
 * query rather than filtering afterwards, so an entry the audience must not
 * have never leaves the database.
 */
export interface AgentMemoryEntry {
  id: string;
  memory_type: string;
  title: string | null;
  content: string;
  origin_room_id: string | null;
  updated_at: string;
}

export interface AgentMemoryAudience {
  spaceId: string;
  agentId: string;
  /** The Room this dispatch is speaking in, or null for a direct chat. */
  roomId: string | null;
  /**
   * The direct chat's person, which *is* the audience there. The same subset
   * test applies: a note reaches this chat when that person may still read its
   * origin Room, and a note taken here has no Room and always does.
   */
  directUserId?: string | null;
}

export async function listAgentMemoryForDispatch(
  db: Queryable,
  audience: AgentMemoryAudience,
  limit = 50,
): Promise<AgentMemoryEntry[]> {
  const targetCanRead = roomConversationReadAccessSql("$1", "$3::varchar", "u.id");
  const originCanRead = roomConversationReadAccessSql("m.space_id", "m.origin_room_id", "audience.user_id");
  const result = await db.query<AgentMemoryEntry>(
    `WITH audience AS (
       -- Who this dispatch speaks in front of: everyone who may read this
       -- Room's conversations, or the one person in a direct chat.
       SELECT u.id AS user_id
         FROM users u
         JOIN space_memberships sm
           ON sm.user_id = u.id AND sm.space_id = $1 AND sm.status = 'active'
        WHERE u.status = 'active'
          AND (
            ($3::varchar IS NOT NULL AND ${targetCanRead})
            OR ($3::varchar IS NULL AND u.id = $4::varchar)
          )
     )
     SELECT m.id, m.memory_type, m.title, m.content, m.origin_room_id,
            m.updated_at
       FROM memory_entries m
      WHERE m.space_id = $1
        AND m.scope_type = 'agent'
        AND m.agent_id = $2
        AND m.status = 'active'
        AND m.deleted_at IS NULL
        -- Private by CHECK; asserted here too, because this is a read that
        -- bypasses the person-facing content gate entirely.
        AND m.visibility = 'private'
        AND (
          -- Delivered everywhere: no origin Room to be filtered by.
          m.memory_type = 'persona'
          -- A note learned in this very Room always reaches it.
          OR ($3::varchar IS NOT NULL AND m.origin_room_id = $3::varchar)
          -- A note learned in another Room reaches this audience only when
          -- nobody in it is someone that Room's audience did not already
          -- contain. An audience with nobody in it receives nothing across:
          -- it is vacuously a subset of every Room, but a transcript outlives
          -- the emptiness and whoever is added next would read what was said.
          OR (m.origin_room_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM audience)
            AND NOT EXISTS (SELECT 1 FROM audience WHERE NOT ${originCanRead}))
          -- A direct-chat note has no Room and reaches only the owner's own
          -- direct chat.
          OR ($3::varchar IS NULL AND $4::varchar IS NOT NULL
            AND m.origin_room_id IS NULL AND m.owner_user_id = $4::varchar)
        )
      ORDER BY (m.memory_type = 'persona') DESC, m.updated_at DESC, m.id ASC
      LIMIT $5`,
    [audience.spaceId, audience.agentId, audience.roomId, audience.directUserId ?? null, limit],
  );
  return result.rows;
}
