import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { PgHostTaskThreadRepository } from "./taskThreadRepository.js";
import { advanceThreadQueue } from "./queueAdvance.js";
import { runOutputResult } from "../runs/orchestrationResults.js";

/**
 * control-center-phase2-plan.md P1: moved out of the (now-async) dispatch
 * route handler into the `agent_run` job handler, which is the only place
 * that still sees the run reach a terminal state — mirrors the
 * `finalizeChatTurn` precedent of a generic post-terminal hook gated on a
 * run shape (`agentRunHandler.ts`).
 *
 * P2 (C4) extends it to drive the message queue from the same hook: a
 * clean `succeeded` terminal tries to advance to the next queued message;
 * anything else (failed, cancelled, degraded, orphaned, timed out,
 * `waiting_for_review` — a plain non-zero exit can land there via the
 * ordinary conformance/verification path, not just server-host runs)
 * pauses the queue instead of silently firing the next message on top of
 * whatever just went wrong.
 */
export async function recordHostTaskThreadOutcome(
  config: ServerConfig,
  threadId: string,
  completedRun: { id: string; status: string; output_json?: unknown },
  resumeAttempted: boolean,
): Promise<void> {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  const threads = new PgHostTaskThreadRepository(pool);
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

  if (completedRun.status === "succeeded") {
    await advanceThreadQueue(pool, threadId);
  } else {
    await threads.pauseQueue(threadId);
  }
}
