import type { MessageOut, SemanticCheckpoint } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { Queryable } from "../routeUtils/common";
import { loadProtocol } from "../providers/protocolRuntime";

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
): Promise<{ messages: MessageOut[]; checkpoint: SemanticCheckpoint | null }> {
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
               AND (source.created_at < boundary.created_at OR source.id=boundary.id)
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
  const messagesResult = watermark > 0
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
      `WITH boundary AS (SELECT created_at,id FROM messages WHERE id=$1 AND space_id=$2 AND session_id=$3)
       SELECT * FROM (SELECT m.id,m.session_id,m.space_id,m.user_id,m.sender_agent_id,m.role,m.content,m.metadata_json,m.created_at
         FROM messages m CROSS JOIN boundary b WHERE m.space_id=$2 AND m.session_id=$3
          AND (m.created_at < b.created_at OR m.id=b.id)
         ORDER BY m.created_at DESC,m.id DESC LIMIT $4) bounded
       ORDER BY bounded.created_at ASC,bounded.id ASC`,
      [input.currentMessageId, input.spaceId, input.sessionId, limit],
    );
  const protocol = await loadProtocol();
  return {
    messages: messagesResult.rows.map(messageOut),
    checkpoint: checkpointResult.rows[0]?.checkpoint_json
      ? protocol.SemanticCheckpointSchema.parse(checkpointResult.rows[0].checkpoint_json) as SemanticCheckpoint
      : null,
  };
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
  return (await loadProtocol()).SemanticCheckpointSchema.parse(result.rows[0].checkpoint_json) as SemanticCheckpoint;
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
