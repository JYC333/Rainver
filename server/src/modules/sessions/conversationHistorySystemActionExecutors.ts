import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import { visibleMessagePathSql } from "./messagePath.js";

/**
 * `conversation.search` / `conversation.read`: the recorded history of the
 * conversation a Run belongs to, read on demand.
 *
 * The vendor CLI session is the Agent's working memory; Rainver keeps every
 * message and every Agent event (`host_thread_events`) as the record. A
 * summary written before a session was renewed, or a session that was
 * compacted, points here for what it left out — the Agent looks a thing up
 * instead of being handed the whole transcript again.
 *
 * Scope is the Run's own conversation and only its visible message path. A
 * Room's messages are shared by its members, and the Run already acts for a
 * person who may read them; the Agent events are those of threads in the same
 * conversation. Bodies are bounded: a search returns excerpts around the
 * match, a read returns whole messages up to a total budget and says when it
 * stopped. Nothing here writes.
 */
const EXCERPT_RADIUS = 160;
const READ_TOTAL_CHARS = 24_000;
const READ_MESSAGE_CHARS = 8_000;

interface SearchInput {
  query: string;
  since?: string;
  until?: string;
  max_results: number;
}

interface ReadInput {
  message_ids?: string[];
  since?: string;
  until?: string;
  max_messages: number;
}

interface SearchHit {
  kind: "message" | "agent_event";
  id: string;
  at: string;
  role: string | null;
  agent_id: string | null;
  excerpt: string;
}

interface ReadMessage {
  id: string;
  at: string;
  role: string;
  user_id: string | null;
  agent_id: string | null;
  content: string;
  truncated: boolean;
}

export class ConversationHistoryService {
  constructor(private readonly db: Queryable) {}

  async search(input: { spaceId: string; sessionId: string; request: SearchInput }): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const { spaceId, sessionId, request } = input;
    const limit = request.max_results + 1;
    const since = request.since ?? null;
    const until = request.until ?? null;
    const messages = await this.db.query<{ id: string; created_at: string; role: string; sender_agent_id: string | null; content: string }>(
      `SELECT message.id, message.created_at, message.role, message.sender_agent_id, message.content
         FROM messages message
        WHERE message.space_id = $1 AND message.session_id = $2
          AND message.content ILIKE '%' || $3 || '%'
          AND ($4::timestamptz IS NULL OR message.created_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR message.created_at <= $5::timestamptz)
          AND ${visibleMessagePathSql({ alias: "message", spaceParam: "$1", sessionParam: "$2" })}
        ORDER BY message.created_at DESC
        LIMIT $6`,
      [spaceId, sessionId, escapeLike(request.query), since, until, limit],
    );
    const events = await this.db.query<{ id: string; created_at: string; event_type: string; agent_id: string | null; text: string }>(
      `SELECT event.id, event.created_at, event.event_type, thread.agent_id,
              COALESCE(event.text, event.tool_input_summary, event.tool_result_summary, '') AS text
         FROM host_thread_events event
         JOIN host_threads thread ON thread.id = event.host_task_thread_id
        WHERE thread.space_id = $1 AND thread.session_id = $2 AND thread.container_kind = 'conversation'
          AND event.event_type IN ('assistant_text', 'tool_activity_started', 'tool_activity_finished')
          AND COALESCE(event.text, event.tool_input_summary, event.tool_result_summary, '') ILIKE '%' || $3 || '%'
          AND ($4::timestamptz IS NULL OR event.created_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR event.created_at <= $5::timestamptz)
        ORDER BY event.created_at DESC
        LIMIT $6`,
      [spaceId, sessionId, escapeLike(request.query), since, until, limit],
    );
    const hits: SearchHit[] = [
      ...messages.rows.map((row): SearchHit => ({
        kind: "message", id: row.id, at: iso(row.created_at), role: row.role,
        agent_id: row.sender_agent_id, excerpt: excerpt(row.content, request.query),
      })),
      ...events.rows.map((row): SearchHit => ({
        kind: "agent_event", id: row.id, at: iso(row.created_at), role: row.event_type,
        agent_id: row.agent_id, excerpt: excerpt(row.text, request.query),
      })),
    ].sort((left, right) => right.at.localeCompare(left.at));
    return { hits: hits.slice(0, request.max_results), truncated: hits.length > request.max_results };
  }

  async read(input: { spaceId: string; sessionId: string; request: ReadInput }): Promise<{ messages: ReadMessage[]; truncated: boolean }> {
    const { spaceId, sessionId, request } = input;
    if (!request.message_ids?.length && !request.since && !request.until) {
      throw new HttpError(422, "conversation.read needs message_ids, or a since/until window");
    }
    const rows = await this.db.query<{ id: string; created_at: string; role: string; user_id: string | null; sender_agent_id: string | null; content: string }>(
      `SELECT message.id, message.created_at, message.role, message.user_id, message.sender_agent_id, message.content
         FROM messages message
        WHERE message.space_id = $1 AND message.session_id = $2
          AND ($3::text[] IS NULL OR message.id = ANY($3::text[]))
          AND ($4::timestamptz IS NULL OR message.created_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR message.created_at <= $5::timestamptz)
          AND ${visibleMessagePathSql({ alias: "message", spaceParam: "$1", sessionParam: "$2" })}
        ORDER BY message.path_depth ASC, message.id ASC
        LIMIT $6`,
      [spaceId, sessionId, request.message_ids?.length ? request.message_ids : null, request.since ?? null, request.until ?? null, request.max_messages + 1],
    );
    const messages: ReadMessage[] = [];
    let total = 0;
    let truncated = rows.rows.length > request.max_messages;
    for (const row of rows.rows.slice(0, request.max_messages)) {
      if (total >= READ_TOTAL_CHARS) { truncated = true; break; }
      const room = Math.min(READ_MESSAGE_CHARS, READ_TOTAL_CHARS - total);
      const content = row.content.length > room ? row.content.slice(0, room) : row.content;
      total += content.length;
      messages.push({
        id: row.id, at: iso(row.created_at), role: row.role, user_id: row.user_id,
        agent_id: row.sender_agent_id, content, truncated: content.length < row.content.length,
      });
    }
    return { messages, truncated };
  }
}

export function registerConversationHistoryExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  if (!config.databaseUrl || !run.session_id) return;
  const sessionId = run.session_id;
  const service = new ConversationHistoryService(getDbPool(config.databaseUrl));
  executors.set("conversation.search" as SystemActionId, async (input) => {
    const output = await service.search({ spaceId: run.space_id, sessionId, request: input as SearchInput });
    return {
      modelResult: { ok: true, tool: "conversation.search", ...output },
      summary: { tool_name: "conversation.search", ok: true, hit_count: output.hits.length, truncated: output.truncated },
    };
  });
  executors.set("conversation.read" as SystemActionId, async (input) => {
    const output = await service.read({ spaceId: run.space_id, sessionId, request: input as ReadInput });
    return {
      modelResult: { ok: true, tool: "conversation.read", ...output },
      summary: { tool_name: "conversation.read", ok: true, message_count: output.messages.length, truncated: output.truncated },
    };
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function excerpt(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, (index < 0 ? 0 : index) - EXCERPT_RADIUS);
  const end = Math.min(text.length, (index < 0 ? 0 : index) + query.length + EXCERPT_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
