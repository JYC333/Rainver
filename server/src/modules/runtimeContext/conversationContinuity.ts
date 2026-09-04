import type { MessageOut, SemanticCheckpoint } from "@rainver/protocol";
import * as protocol from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import type { RoomSummaryCoverage } from "../rooms/conversationContext.js";
import { visibleMessagePathSql } from "../sessions/messagePath.js";

interface MessageRow {
  id: string;
  session_id: string;
  space_id: string;
  user_id: string | null;
  sender_agent_id: string | null;
  role: string;
  content: string;
  metadata_json: unknown;
  created_at: Date | string;
}

/** Load the canonical checkpoint + raw message tail at a trigger watermark. */
export async function loadConversationContinuityThroughMessage(
  db: Queryable,
  input: {
    spaceId: string;
    sessionId: string;
    workContextScopeId: string;
    currentMessageId: string;
    limit?: number;
  },
): Promise<{ messages: MessageOut[]; checkpoint: SemanticCheckpoint | null; room_summary: RoomSummaryCoverage | null; room_conversation: boolean }> {
  const limit = Math.max(1, Math.floor(input.limit ?? 80));
  const checkpointResult = await db.query<{ checkpoint_json: unknown; covered_cursor: number; watermark: number }>(
    `WITH watermark AS (
       SELECT COALESCE(max(event.scope_sequence),0)::int AS cursor
         FROM context_events event
        WHERE event.space_id=$1 AND event.work_context_scope_id=$2
          AND event.canonical_ref_json->>'type'='message'
          AND EXISTS (
            SELECT 1 FROM messages source, messages boundary
             WHERE source.id=event.canonical_ref_json->>'id' AND source.space_id=event.space_id
               AND boundary.id=$3 AND boundary.space_id=$1 AND boundary.session_id=$4
               AND source.session_id=boundary.session_id
               AND (
                 source.created_at < boundary.created_at
                 OR (source.created_at = boundary.created_at AND source.id <= boundary.id)
               )
          )
     )
     SELECT checkpoint.checkpoint_json,checkpoint.covered_cursor,watermark.cursor AS watermark
       FROM watermark LEFT JOIN LATERAL (
         SELECT checkpoint_json,covered_cursor FROM context_semantic_checkpoints
          WHERE space_id=$1 AND work_context_scope_id=$2
            AND covered_cursor<=watermark.cursor
          ORDER BY version DESC LIMIT 1
       ) checkpoint ON true`,
    [input.spaceId, input.workContextScopeId, input.currentMessageId, input.sessionId],
  );
  const watermark = Number(checkpointResult.rows[0]?.watermark ?? 0);
  const coveredCursor = Number(checkpointResult.rows[0]?.covered_cursor ?? 0);
  const roomResult = await db.query<{ room_id: string | null }>(
    `SELECT room_id FROM sessions WHERE id=$1 AND space_id=$2 LIMIT 1`,
    [input.sessionId, input.spaceId],
  );
  const roomId = roomResult.rows[0]?.room_id ?? null;
  const roomSummaryResult = roomId
    ? await db.query<RoomSummaryCoverage>(
        `SELECT id,version,summary_text,covered_through_message_id,covered_through_created_at
           FROM room_conversation_summary_versions
          WHERE space_id=$1 AND room_id=$2 AND session_id=$3 AND status='active'
          ORDER BY version DESC LIMIT 1`,
        [input.spaceId, roomId, input.sessionId],
      )
    : { rows: [] as RoomSummaryCoverage[] };
  const roomSummary = roomSummaryResult.rows[0]
    ? {
        ...roomSummaryResult.rows[0],
        covered_through_created_at: isoDate(roomSummaryResult.rows[0].covered_through_created_at),
      }
    : null;
  const messagesResult = roomId
    ? await loadRoomMessagesThrough(db, {
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        currentMessageId: input.currentMessageId,
        summary: roomSummary,
      })
    : watermark > 0
    ? await db.query<MessageRow>(
      `SELECT id,session_id,space_id,user_id,sender_agent_id,role,content,metadata_json,created_at FROM (
         SELECT message.id,message.session_id,message.space_id,message.user_id,message.sender_agent_id,
                message.role,message.content,message.metadata_json,message.created_at,event.scope_sequence
           FROM context_events event
           JOIN messages message ON message.id=event.canonical_ref_json->>'id' AND message.space_id=event.space_id
          WHERE event.space_id=$1 AND event.work_context_scope_id=$2
            AND event.canonical_ref_json->>'type'='message'
            AND event.scope_sequence>$3 AND event.scope_sequence<=$4
            AND message.session_id=$5
          ORDER BY event.scope_sequence DESC LIMIT $6
       ) bounded ORDER BY scope_sequence`,
      [input.spaceId, input.workContextScopeId, coveredCursor, watermark, input.sessionId, limit],
    )
    : await db.query<MessageRow>(
      // The window is the visible path up to the triggering message, in path
      // order. Ordering and bounding by `path_depth` rather than `created_at`
      // is what keeps the prompt and the transcript telling the same story
      // once a conversation has branched.
      `WITH boundary AS (SELECT path_depth,id FROM messages WHERE id=$1 AND space_id=$2 AND session_id=$3)
       SELECT * FROM (SELECT m.id,m.session_id,m.space_id,m.user_id,m.sender_agent_id,m.role,m.content,m.metadata_json,m.path_depth,m.created_at
         FROM messages m CROSS JOIN boundary b WHERE m.space_id=$2 AND m.session_id=$3
          AND ${visibleMessagePathSql({ alias: "m", spaceParam: "$2", sessionParam: "$3" })}
          AND (
            m.path_depth < b.path_depth
            OR (m.path_depth = b.path_depth AND m.id <= b.id)
          )
         ORDER BY m.path_depth DESC,m.id DESC LIMIT $4) bounded
       ORDER BY bounded.path_depth ASC,bounded.id ASC`,
      [input.currentMessageId, input.spaceId, input.sessionId, limit],
    );
  return {
    messages: messagesResult.rows.map(messageOut),
    checkpoint: checkpointResult.rows[0]?.checkpoint_json
      ? protocol.SemanticCheckpointSchema.parse(checkpointResult.rows[0].checkpoint_json) as SemanticCheckpoint
      : null,
    room_summary: roomSummary,
    room_conversation: Boolean(roomId),
  };
}

/** Load the summary-aware Room tail when the current turn is a run request. */
export async function loadRoomContinuityForRunRequest(
  db: Queryable,
  input: { spaceId: string; sessionId: string; limit?: number },
): Promise<{ messages: MessageOut[]; room_summary: RoomSummaryCoverage | null; room_conversation: true }> {
  const summaryResult = await db.query<RoomSummaryCoverage>(
    `SELECT summary.id,summary.version,summary.summary_text,
            summary.covered_through_message_id,summary.covered_through_created_at
       FROM room_conversation_summary_versions summary
       JOIN sessions session_row
         ON session_row.id=summary.session_id AND session_row.space_id=summary.space_id
        AND session_row.room_id=summary.room_id
      WHERE summary.space_id=$1 AND summary.session_id=$2 AND summary.status='active'
      ORDER BY summary.version DESC LIMIT 1`,
    [input.spaceId, input.sessionId],
  );
  const row = summaryResult.rows[0];
  const roomSummary = row
    ? { ...row, covered_through_created_at: isoDate(row.covered_through_created_at) }
    : null;
  const result = await db.query<MessageRow>(
    `SELECT m.id,m.session_id,m.space_id,m.user_id,m.sender_agent_id,m.role,m.content,m.metadata_json,m.path_depth,m.created_at
       FROM messages m
      WHERE m.space_id=$1 AND m.session_id=$2
        AND ${visibleMessagePathSql({ alias: "m", spaceParam: "$1", sessionParam: "$2" })}
        -- The coverage cursor names a message; what matters is everything
        -- after that message *on the path*. Filtering by its timestamp while
        -- taking the newest N by position mixes two keys, and the LIMIT can
        -- then clip a different row than the filter admitted — reachable
        -- because attaching references stamps timestamps past the wall clock
        -- (see referenceService), so clock order and path order can invert.
        AND ($3::varchar IS NULL OR m.path_depth > COALESCE((
              SELECT covered.path_depth FROM messages covered
               WHERE covered.id=$3 AND covered.space_id=$1 AND covered.session_id=$2
            ), -1))
      ORDER BY m.path_depth DESC,m.id DESC LIMIT $4`,
    [input.spaceId, input.sessionId,
      roomSummary?.covered_through_message_id ?? null,
      Math.max(1, Math.min(2048, Math.floor(input.limit ?? 2048)))],
  );
  return { messages: result.rows.reverse().map(messageOut), room_summary: roomSummary, room_conversation: true };
}

/**
 * Load the canonical Room replay window through a trigger message.  The
 * caller still decides how to render the result, but the database boundary
 * is shared with Runtime Context so managed replay cannot drift back to a
 * second fixed-size history implementation.
 */
export async function loadRoomConversationReplayThroughMessage(
  db: Queryable,
  input: { spaceId: string; sessionId: string; currentMessageId: string },
): Promise<{ messages: MessageOut[]; summary: RoomSummaryCoverage | null }> {
  const summaryResult = await db.query<RoomSummaryCoverage>(
    `SELECT summary.id,summary.version,summary.summary_text,
            summary.covered_through_message_id,summary.covered_through_created_at
       FROM room_conversation_summary_versions summary
       JOIN sessions session_row
         ON session_row.id=summary.session_id AND session_row.space_id=summary.space_id
        AND session_row.room_id=summary.room_id
      WHERE summary.space_id=$1 AND summary.session_id=$2 AND summary.status='active'
      ORDER BY summary.version DESC LIMIT 1`,
    [input.spaceId, input.sessionId],
  );
  const summary = summaryResult.rows[0]
    ? {
        ...summaryResult.rows[0],
        covered_through_created_at: isoDate(summaryResult.rows[0].covered_through_created_at),
      }
    : null;
  const messages = await loadRoomMessagesThrough(db, {
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    currentMessageId: input.currentMessageId,
    summary,
  });
  return { messages: messages.rows.map(messageOut), summary };
}

async function loadRoomMessagesThrough(
  db: Queryable,
  input: {
    spaceId: string;
    sessionId: string;
    currentMessageId: string;
    summary: RoomSummaryCoverage | null;
  },
): Promise<{ rows: MessageRow[] }> {
  const result = await db.query<MessageRow>(
    `WITH boundary AS (
       SELECT path_depth,created_at,id FROM messages
        WHERE id=$3 AND space_id=$1 AND session_id=$2
     )
     SELECT id,session_id,space_id,user_id,sender_agent_id,role,content,metadata_json,path_depth,created_at
       FROM (
         SELECT message.*
           FROM messages message CROSS JOIN boundary
          WHERE message.space_id=$1 AND message.session_id=$2
            AND ${visibleMessagePathSql({ alias: "message", spaceParam: "$1", sessionParam: "$2" })}
            AND (
              message.path_depth < boundary.path_depth
              OR (message.path_depth = boundary.path_depth AND message.id <= boundary.id)
            )
            -- The coverage cursor names a message; the window is everything
            -- after it on the path. Comparing its timestamp instead drops an
            -- on-path message whose clock is behind the cursor's, which a
            -- reference stamped past the wall clock produces (see
            -- referenceService) — and that message is then missing from the
            -- Agent's prompt while the transcript still shows it.
            AND (
              message.id=boundary.id
              OR $4::varchar IS NULL
              OR message.path_depth > COALESCE((
                   SELECT covered.path_depth FROM messages covered
                    WHERE covered.id=$4 AND covered.space_id=$1 AND covered.session_id=$2
                 ), -1)
            )
          ORDER BY message.path_depth DESC,message.id DESC
          LIMIT 2048
       ) bounded
      ORDER BY bounded.path_depth ASC,bounded.id ASC`,
    [input.spaceId, input.sessionId, input.currentMessageId,
      input.summary?.covered_through_message_id ?? null],
  );
  return result;
}

export async function loadActiveSemanticCheckpoint(
  db: Queryable,
  spaceId: string,
  workContextScopeId: string,
): Promise<SemanticCheckpoint | null> {
  const result = await db.query<{ checkpoint_json: unknown }>(
    `SELECT checkpoint_json FROM context_semantic_checkpoints
      WHERE space_id=$1 AND work_context_scope_id=$2 AND status='active'
      ORDER BY version DESC LIMIT 1`,
    [spaceId, workContextScopeId],
  );
  if (!result.rows[0]) return null;
  return protocol.SemanticCheckpointSchema.parse(result.rows[0].checkpoint_json) as SemanticCheckpoint;
}

function messageOut(row: MessageRow): MessageOut {
  return {
    id: row.id, session_id: row.session_id, space_id: row.space_id,
    user_id: row.user_id, sender_agent_id: row.sender_agent_id,
    role: row.role, content: row.content,
    metadata_json: recordOrNull(row.metadata_json),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
