import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool";
import type { Queryable } from "../routeUtils/common";
import { withDbTransaction } from "../routeUtils/common";
import { PgHostRepository } from "./repository";
import { PgHostTaskThreadRepository } from "./taskThreadRepository";
import { PgHostThreadMessageRepository } from "./threadMessageRepository";
import { ensureRemoteDispatchAgent } from "./remoteDispatchAgent";
import { PgJobQueueRepository } from "../jobs/repository";
import { isTerminalRunStatus } from "../runs/orchestrationResults";

const LOCK_PREFIX = "host_thread_queue:";

export type AdvanceResult =
  | { advanced: true; run_id: string; message_id: string }
  | { advanced: false; reason: "thread_not_found" | "paused" | "run_active" | "host_offline" | "queue_empty" };

/**
 * control-center-phase2-plan.md P2 (C4): pops and dispatches the oldest
 * still-`queued` message for a thread, unless something blocks it — paused,
 * a run already active, or the host currently offline (the message stays
 * queued; nothing in this phase re-triggers on host reconnect, so it waits
 * for the next dispatch or completion to try again). Called from both the
 * dispatch route (right after a caller enqueues a message, in case nothing
 * is blocking an immediate send) and `agentRunHandler.ts`'s post-terminal
 * hook (right after a Run completes cleanly) — these two callers can race
 * each other for the same thread (a Run completes right as the user sends a
 * new message), so the "no active run, pop the oldest queued message,
 * create its Run" sequence runs inside one transaction holding
 * `pg_advisory_xact_lock(hashtext('host_thread_queue:' || threadId))` —
 * without it, two concurrent callers could both observe "nothing active"
 * and both pop and dispatch the *same* message as two separate Runs
 * (discovery review, P2). A separate lock namespace from
 * `host_thread_events`' — the two protect different invariants and
 * needlessly serializing event writes against queue advancement would only
 * add contention for no correctness benefit.
 *
 * Host/agent resolution happens *before* the lock is taken — read-only
 * (host online-ness) or independently idempotent (the system agent), not
 * part of the "only one active Run per thread" invariant the lock protects,
 * so there's nothing to gain by holding it longer.
 *
 * Every dispatch this function creates resolves the space's system
 * remote-dispatch agent (C8) — a queued message has no request context to
 * carry an explicit `agent_id` even if one were still accepted.
 *
 * `timeoutMsForNewMessage` only applies if the message this call actually
 * pops out to dispatch is the one the caller just enqueued (checked by id,
 * not merely assumed) — the dispatch route passes its own request's
 * `timeout_ms` here, but if something else was already ahead in the queue,
 * THAT message dispatches instead and gets the runtime's ordinary default
 * timeout, not a value from a request it was never part of. Omitted
 * entirely by the post-completion auto-advance caller, which has no
 * request to carry one from. The dispatch route must compare its own
 * enqueued message id against this function's returned `message_id` before
 * reporting the outcome to its caller — they can differ under the same
 * race this lock closes at the data level (a slower request's message can
 * lose the race to an earlier-queued one), and telling the caller "your
 * message dispatched" when a *different* one actually did would be wrong.
 */
export async function advanceThreadQueue(
  pool: Pool,
  threadId: string,
  timeoutMsForNewMessage?: { messageId: string; timeoutMs: number | null },
): Promise<AdvanceResult> {
  const threads = new PgHostTaskThreadRepository(pool);
  const thread = await threads.getById(threadId);
  if (!thread) return { advanced: false, reason: "thread_not_found" };

  const hosts = new PgHostRepository(pool);
  const target = await hosts.resolveDispatchTarget(thread.project_folder_id);
  if (!target || !target.host_online) return { advanced: false, reason: "host_offline" };
  const agent = await ensureRemoteDispatchAgent(pool, target.space_id);

  return withDbTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${LOCK_PREFIX}${threadId}`]);

    // Re-read pause state and the latest run's status under the lock — both
    // could have changed since the reads above, by the very race this lock
    // exists to close.
    const freshThread = await new PgHostTaskThreadRepository(client).getById(threadId);
    if (!freshThread) return { advanced: false, reason: "thread_not_found" };
    if (freshThread.queue_paused_at) return { advanced: false, reason: "paused" };

    // By construction this function is the only path that starts a new Run
    // for a thread, and it always takes this lock first — so the latest run
    // is enough to check, not every run in the thread's history.
    // `isTerminalRunStatus` (not a hand-rolled status list) so this stays
    // correct if the terminal-status set ever grows — a hand-rolled copy
    // here previously missed `waiting_for_review`, silently deadlocking the
    // queue after any run that landed in review.
    const latestRun = await client.query<{ status: string }>(
      `SELECT status FROM runs WHERE host_task_thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [threadId],
    );
    const latestStatus = latestRun.rows[0]?.status;
    if (latestStatus && !isTerminalRunStatus(latestStatus)) return { advanced: false, reason: "run_active" };

    const messages = new PgHostThreadMessageRepository(client);
    const next = await messages.nextQueued(threadId);
    if (!next) return { advanced: false, reason: "queue_empty" };

    const { runId } = await createAndQueueRun(client, {
      spaceId: target.space_id,
      projectId: target.project_id,
      projectFolderId: freshThread.project_folder_id,
      threadId: freshThread.id,
      adapterType: freshThread.adapter_type,
      prompt: next.prompt,
      resumeSessionId: freshThread.vendor_session_id,
      userId: next.created_by_user_id,
      agent,
      timeoutMs: timeoutMsForNewMessage?.messageId === next.id ? timeoutMsForNewMessage.timeoutMs : null,
    });
    await messages.markDispatched(next.id, runId);
    return { advanced: true, run_id: runId, message_id: next.id };
  });
}

/**
 * The shared "insert a Run row, enqueue its `agent_run` job" core, used by
 * both `advanceThreadQueue` and nothing else today — kept as its own
 * function (rather than inlined) so the shape stays obviously identical
 * regardless of which caller reaches it. Takes a `Queryable`, not
 * specifically a `Pool`: `advanceThreadQueue` calls it with the
 * transaction/lock-holding client, not the pool directly, so this must not
 * open its own separate connection.
 */
async function createAndQueueRun(db: Queryable, params: {
  spaceId: string;
  projectId: string;
  projectFolderId: string;
  threadId: string;
  adapterType: string;
  prompt: string;
  resumeSessionId: string | null;
  userId: string;
  agent: { id: string; current_version_id: string };
  timeoutMs: number | null;
}): Promise<{ runId: string }> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       project_id, project_folder_id, host_task_thread_id, adapter_type, required_sandbox_level,
       prompt, owner_user_id, instructed_by_user_id, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'system', 'manual', 'queued', 'live',
       $5, $6, $7, $8, 'none',
       $9, $10, $10, $11, $11
     )`,
    [
      runId,
      params.spaceId,
      params.agent.id,
      params.agent.current_version_id,
      params.projectId,
      params.projectFolderId,
      params.threadId,
      params.adapterType,
      params.prompt,
      params.userId,
      now,
    ],
  );

  const queue = new PgJobQueueRepository(db);
  await queue.ensureAgentRunJob({
    job_type: "agent_run",
    space_id: params.spaceId,
    user_id: params.userId,
    project_folder_id: params.projectFolderId,
    agent_id: params.agent.id,
    payload: {
      run_id: runId,
      adapter_config: params.resumeSessionId ? { remote_resume_session_id: params.resumeSessionId } : {},
      host_task_thread_id: params.threadId,
      host_thread_resume_attempted: Boolean(params.resumeSessionId),
      timeout_ms: params.timeoutMs,
    },
  });
  return { runId };
}
