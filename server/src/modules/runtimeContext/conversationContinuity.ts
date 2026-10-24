import type { MessageOut, SemanticCheckpoint } from "@rainver/protocol";
import * as protocol from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { nonSupersededMessageSql, visibleMessagePathSql } from "../sessions/messagePath.js";

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
): Promise<{ messages: MessageOut[]; checkpoint: SemanticCheckpoint | null; room_conversation: boolean }> {
  const limit = Math.max(1, Math.floor(input.limit ?? 80));
  const checkpointResult = await db.query<{ checkpoint_json: unknown; covered_cursor: number; watermark: number }>(
    `WITH message_window AS (
       SELECT event.scope_sequence, EXISTS (
         SELECT 1 FROM messages source, messages boundary
          WHERE source.id=event.canonical_ref_json->>'id' AND source.space_id=event.space_id
            AND boundary.id=$3 AND boundary.space_id=$1 AND boundary.session_id=$4
            AND source.session_id=boundary.session_id
            AND source.path_depth<=boundary.path_depth
            AND ${visibleMessagePathSql({ alias: "source", spaceParam: "$1", sessionParam: "$4" })}
       ) AS in_window
         FROM context_events event
        WHERE event.space_id=$1 AND event.work_context_scope_id=$2
          AND event.canonical_ref_json->>'type'='message'
     ), watermark AS (
       -- Recovery can append an earlier message after a later one. A
       -- checkpoint covers a ledger prefix, so it must stop before the first
       -- message outside this trigger's canonical path, even in that case.
       SELECT LEAST(COALESCE(max(scope_sequence) FILTER (WHERE in_window),0),
                    min(scope_sequence) FILTER (WHERE NOT in_window)-1)::int AS cursor
         FROM message_window
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
  const coveredCursor = Number(checkpointResult.rows[0]?.covered_cursor ?? 0);
  const roomResult = await db.query<{ room_id: string | null }>(
    `SELECT room_id FROM sessions WHERE id=$1 AND space_id=$2 LIMIT 1`,
    [input.sessionId, input.spaceId],
  );
  const roomId = roomResult.rows[0]?.room_id ?? null;
  const messagesResult = roomId
    ? await loadRoomMessagesThrough(db, {
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        currentMessageId: input.currentMessageId,
      })
    : await db.query<MessageRow>(
      // The window is the visible path up to the triggering message, in path
      // order. Ordering and bounding by `path_depth` rather than `created_at`
      // is what keeps the prompt and the transcript telling the same story
      // once a conversation has branched.
      `WITH boundary AS (SELECT path_depth,id FROM messages WHERE id=$1 AND space_id=$2 AND session_id=$3)
       SELECT * FROM (SELECT m.id,m.session_id,m.space_id,m.user_id,m.sender_agent_id,m.role,m.content,m.metadata_json,m.path_depth,m.created_at
         FROM messages m CROSS JOIN boundary b WHERE m.space_id=$2 AND m.session_id=$3
          AND ${visibleMessagePathSql({ alias: "m", spaceParam: "$2", sessionParam: "$3" })}
          AND ${nonSupersededMessageSql("m")}
          AND (
            m.path_depth < b.path_depth
            OR (m.path_depth = b.path_depth AND m.id <= b.id)
          )
          -- Capture may be partial or late. Canonical messages still belong
          -- in the tail unless this checkpoint actually captured them. The
          -- current input always remains available to the current-message
          -- renderer, which excludes it from historical text.
          AND (m.id=b.id OR NOT EXISTS (
            SELECT 1 FROM context_events covered
             WHERE covered.space_id=$2 AND covered.work_context_scope_id=$5
               AND covered.scope_sequence<=$6
               AND covered.canonical_ref_json->>'type'='message'
               AND covered.canonical_ref_json->>'id'=m.id
          ))
         ORDER BY m.path_depth DESC,m.id DESC LIMIT $4) bounded
       ORDER BY bounded.path_depth ASC,bounded.id ASC`,
      [input.currentMessageId, input.spaceId, input.sessionId, limit, input.workContextScopeId, coveredCursor],
    );
  return {
    messages: messagesResult.rows.map(messageOut),
    checkpoint: checkpointResult.rows[0]?.checkpoint_json
      ? protocol.SemanticCheckpointSchema.parse(checkpointResult.rows[0].checkpoint_json) as SemanticCheckpoint
      : null,
    room_conversation: Boolean(roomId),
  };
}

/** Load the Room tail, newest last, when the current turn is a run request. */
export async function loadRoomContinuityForRunRequest(
  db: Queryable,
  input: { spaceId: string; sessionId: string; limit?: number },
): Promise<{ messages: MessageOut[]; room_conversation: true }> {
  const result = await db.query<MessageRow>(
    `SELECT m.id,m.session_id,m.space_id,m.user_id,m.sender_agent_id,m.role,m.content,m.metadata_json,m.path_depth,m.created_at
       FROM messages m
      WHERE m.space_id=$1 AND m.session_id=$2
        AND ${visibleMessagePathSql({ alias: "m", spaceParam: "$1", sessionParam: "$2" })}
        AND ${nonSupersededMessageSql("m")}
      ORDER BY m.path_depth DESC,m.id DESC LIMIT $3`,
    [input.spaceId, input.sessionId, Math.max(1, Math.min(2048, Math.floor(input.limit ?? 2048)))],
  );
  return { messages: result.rows.reverse().map(messageOut), room_conversation: true };
}

async function loadRoomMessagesThrough(
  db: Queryable,
  input: {
    spaceId: string;
    sessionId: string;
    currentMessageId: string;
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
            AND ${nonSupersededMessageSql("message")}
            AND (
              message.path_depth < boundary.path_depth
              OR (message.path_depth = boundary.path_depth AND message.id <= boundary.id)
            )
          ORDER BY message.path_depth DESC,message.id DESC
          LIMIT 2048
       ) bounded
      ORDER BY bounded.path_depth ASC,bounded.id ASC`,
    [input.spaceId, input.sessionId, input.currentMessageId],
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
