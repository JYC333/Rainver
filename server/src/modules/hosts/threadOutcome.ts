import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { PgHostThreadRepository } from "./threadRepository.js";
import { runOutputResult } from "../runs/orchestrationResults.js";
import { PgSessionRepository } from "../sessions/repository.js";

/**
 * control-center-phase2-plan.md P1: moved out of the (now-async) dispatch
 * route handler into the `agent_run` job handler, which is the only place
 * that still sees the run reach a terminal state — mirrors the
 * `finalizeChatTurn` precedent of a generic post-terminal hook gated on a
 * run shape (`agentRunHandler.ts`).
 *
 * It records the vendor session the run came back with, and says so in the
 * Room when a resume was attempted and came back empty — a context reset is
 * something the person needs to know about, because the Agent has forgotten
 * what they were doing.
 *
 * It used to drive a per-thread message queue from here as well. That queue
 * existed for the Command Center's thread page; with the page gone nothing
 * could resume a paused one, so a remote Task run whose predecessor failed
 * would have sat queued forever. A remote Task run is admitted like a server
 * one now — one Run, created synchronously.
 */
export async function recordHostThreadOutcome(
  config: ServerConfig,
  threadId: string,
  completedRun: { id: string; status: string; output_json?: unknown; error_json?: unknown },
  resumeAttempted: boolean,
  identity: { digest: string; sent: boolean } | null = null,
): Promise<void> {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  const threads = new PgHostThreadRepository(pool);
  const result = runOutputResult(completedRun.output_json);
  const rawSessionId = result.external_session_id;
  const externalSessionId = typeof rawSessionId === "string" && rawSessionId ? rawSessionId : null;
  const errorJson = completedRun.error_json;
  const errorCode = errorJson && typeof errorJson === "object" && !Array.isArray(errorJson)
    ? (errorJson as Record<string, unknown>).error_code
    : null;
  const sessionReset = resumeAttempted && !externalSessionId && (
    errorCode === "runtime_session_invalid"
    || completedRun.status === "succeeded"
    || completedRun.status === "degraded"
  );
  await threads.recordRunOutcome(threadId, {
    lastRunId: completedRun.id,
    vendorSessionId: externalSessionId,
    // A resume was attempted and proved broken: the runtime refused the
    // session (`runtime_session_invalid`), or finished a turn without handing
    // one back. Nothing else says so. A Run that failed before the runtime
    // tried — the host offline, a launch that waited out its budget behind
    // another writer, a person's stop — produces no session id either, but
    // the session it would have resumed is still there. Not attempting a
    // resume at all (a thread's first-ever dispatch) never counts.
    sessionReset,
    // A completed turn is the proof the prompt reached the runtime. A failed
    // or cancelled Run may have died before it; it then records nothing, and
    // the next turn sends the identity block again — the safe direction.
    landed: Boolean(externalSessionId)
      && (completedRun.status === "succeeded" || completedRun.status === "degraded"),
    identity,
    contextWindow: contextWindowFrom(result.context_window),
  });

  if (sessionReset) {
    const conversation = await pool.query<{
      space_id: string;
      room_id: string;
      session_id: string | null;
      agent_name: string;
      created_by_user_id: string;
    }>(
      `SELECT session_row.space_id, session_row.room_id, thread.last_session_id AS session_id,
              COALESCE(NULLIF(agent.name, ''), thread.agent_id) AS agent_name,
              thread.created_by_user_id
         FROM host_threads thread
         JOIN sessions session_row ON session_row.id = thread.session_id AND session_row.space_id = thread.space_id
         JOIN agents agent ON agent.id = thread.agent_id AND agent.space_id = thread.space_id
        WHERE thread.id = $1 AND thread.container_kind = 'conversation'
          AND session_row.room_id IS NOT NULL AND thread.agent_id IS NOT NULL
          AND thread.status <> 'closed'
        LIMIT 1`,
      [threadId],
    );
    const owner = conversation.rows[0];
    if (owner?.session_id) {
      const existing = await pool.query(
        `SELECT 1 FROM messages
          WHERE space_id = $1 AND session_id = $2
            AND metadata_json->>'host_thread_id' = $3
            AND metadata_json->>'host_thread_event' = 'session_reset'
          LIMIT 1`,
        [owner.space_id, owner.session_id, threadId],
      );
      if (!existing.rows[0]) {
        await new PgSessionRepository(pool).addRoomSystemNotice(
          owner.space_id,
          owner.created_by_user_id,
          owner.room_id,
          owner.session_id,
          {
            content: `${owner.agent_name}'s context was reset`,
            metadata: {
              host_thread_id: threadId,
              host_thread_event: "session_reset",
            },
          },
        );
      }
    }
  }
}

function contextWindowFrom(value: unknown): { used: number; size: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { used, size } = value as Record<string, unknown>;
  return typeof used === "number" && Number.isInteger(used) && used >= 0
    && typeof size === "number" && Number.isInteger(size) && size > 0
    ? { used, size }
    : null;
}
