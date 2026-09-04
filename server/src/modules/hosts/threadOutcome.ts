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
  completedRun: { id: string; status: string; output_json?: unknown },
  resumeAttempted: boolean,
): Promise<void> {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  const threads = new PgHostThreadRepository(pool);
  const rawSessionId = runOutputResult(completedRun.output_json).external_session_id;
  const externalSessionId = typeof rawSessionId === "string" && rawSessionId ? rawSessionId : null;
  await threads.recordRunOutcome(threadId, {
    lastRunId: completedRun.id,
    vendorSessionId: externalSessionId,
    // A resume was attempted (the thread already had a vendor session) but
    // came back empty — the daemon could not resume it. Not attempting a
    // resume at all (a thread's first-ever dispatch) never counts as a
    // reset, even though it also produces no prior session id.
    sessionReset: resumeAttempted && !externalSessionId,
  });

  if (resumeAttempted && !externalSessionId) {
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
