import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { withDbTransaction } from "../routeUtils/common.js";
import { PgWorkspaceLocationRepository } from "../projectFolders/workspaceLocations.js";
import { PgHostTaskThreadRepository } from "./taskThreadRepository.js";
import { PgHostThreadMessageRepository } from "./threadMessageRepository.js";
import { ensureRemoteDispatchAgent } from "./remoteDispatchAgent.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { isTerminalRunStatus } from "../runs/orchestrationResults.js";
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from "../projects/access.js";
import { assertBudgetSourcesAvailable, RunBudgetExceededError } from "../runs/budgetEnforcement.js";
import { budgetSourcesFromPolicy, createRunContractSnapshot, type RunBudgetSource } from "../runs/contractSnapshot.js";
import { getLocalCliRuntimeAdapterSpec } from "../runtimeAdapters/index.js";
import {
  settleTaskAfterQueuedMessageWithdrawal,
  withdrawQueuedTaskMessages,
} from "../tasks/taskRunStatusProjection.js";

export const HOST_THREAD_QUEUE_LOCK_PREFIX = "host_thread_queue:";

export type AdvanceResult =
  | { advanced: true; run_id: string; message_id: string }
  | { advanced: false; reason: "thread_not_found" | "paused" | "run_active" | "host_offline" | "queue_empty" | "task_missing" | "task_not_runnable" | "task_authority_lost" | "task_budget_exhausted" };

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

  const locations = new PgWorkspaceLocationRepository(pool);
  const initialTarget = await locations.resolveDispatchTarget(thread.workspace_location_id);
  if (!initialTarget || !initialTarget.host_online || !initialTarget.execution_ready) return { advanced: false, reason: "host_offline" };
  const agent = await ensureRemoteDispatchAgent(pool, initialTarget.space_id);

  return withDbTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${HOST_THREAD_QUEUE_LOCK_PREFIX}${threadId}`]);

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
    for (;;) {
      const next = await messages.nextQueued(threadId);
      if (!next) return { advanced: false, reason: "queue_empty" };

    // The preflight target was read before this transaction. Re-resolve it
    // here so a location becoming unready, a host going offline, or a
    // topology change between enqueue and queue advancement cannot result in
    // a Run being admitted against stale execution state.
    const target = await new PgWorkspaceLocationRepository(client).resolveDispatchTarget(freshThread.workspace_location_id);
    if (!target || !target.host_online || !target.execution_ready) return { advanced: false, reason: "host_offline" };

    // Capability state is a heartbeat fact just like readiness. Recheck it at
    // the point where the queued message becomes a Run, because the runtime
    // may have disappeared after the request enqueued the message.
    const adapter = getLocalCliRuntimeAdapterSpec(freshThread.adapter_type);
    const reportedRuntimes = Array.isArray((target.capabilities_json as { runtimes?: unknown })?.runtimes)
      ? ((target.capabilities_json as { runtimes: unknown[] }).runtimes as unknown[])
      : [];
    const capabilityProbeCommand = adapter?.invocation.remote_capability_probe ?? adapter?.executable.command;
    if (!adapter || adapter.implementation_status !== "implemented" || adapter.invocation.protocol !== "acp"
      || (capabilityProbeCommand && !reportedRuntimes.includes(capabilityProbeCommand))) {
      return { advanced: false, reason: "host_offline" };
    }

    // Read the Task without taking its row lock first. Project -> Task is the
    // lock order for Project-owned mutations; taking Task first would allow a
    // concurrent archive/dispatch cycle to deadlock.
    const task = await client.query<{
      project_id: string | null;
      project_folder_id: string | null;
      max_runs: number | null;
      max_cost: number | null;
      max_duration_seconds: number | null;
      policy_json: unknown;
      status: string;
    }>(
      `SELECT project_id, project_folder_id, max_runs, max_cost, max_duration_seconds, policy_json, status
         FROM tasks WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [next.task_id, target.space_id],
    );
    const taskPreview = task.rows[0];
    if (!taskPreview || taskPreview.project_folder_id !== target.project_folder_id || taskPreview.project_id !== target.project_id) {
      await messages.withdraw(freshThread.id, next.id);
      continue;
    }
    try {
      await lockActiveProjectForMutation(client, target.space_id, target.project_id);
      await assertProjectWriterForMutation(client, target.space_id, target.project_id, next.created_by_user_id);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      await messages.withdrawQueuedForTask(freshThread.id, next.task_id);
      await settleTaskAfterQueuedMessageWithdrawal(client, target.space_id, freshThread.id, next.id);
      return { advanced: false, reason: "task_authority_lost" };
    }

    const lockedTask = await client.query<{
      project_id: string | null;
      project_folder_id: string | null;
      max_runs: number | null;
      max_cost: number | null;
      max_duration_seconds: number | null;
      policy_json: unknown;
      status: string;
    }>(
      `SELECT project_id, project_folder_id, max_runs, max_cost, max_duration_seconds, policy_json, status
         FROM tasks WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [next.task_id, target.space_id],
    );
    const taskRow = lockedTask.rows[0];
    if (!taskRow || taskRow.project_folder_id !== target.project_folder_id || taskRow.project_id !== target.project_id) {
      await messages.withdraw(freshThread.id, next.id);
      continue;
    }
    if (["done", "cancelled", "blocked"].includes(taskRow.status)) {
      // The Task row is locked, so another queue cannot pass its own locked
      // reread and dispatch this Task until this transaction commits. That
      // makes it safe to withdraw queued messages on every thread without
      // taking those other advisory locks here (which would invert the
      // queue->Task lock order and permit a cross-thread deadlock).
      await withdrawQueuedTaskMessages(client, target.space_id, [next.task_id]);
      continue;
    }
    const runCount = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task_runs WHERE task_id = $1 AND space_id = $2`,
      [next.task_id, target.space_id],
    );
    if (taskRow.max_runs !== null && Number(runCount.rows[0]?.count ?? "0") >= taskRow.max_runs) {
      await client.query(
        `UPDATE tasks SET status = 'blocked', blocked_reason = 'Task run limit reached', updated_at = now()
          WHERE id = $1 AND space_id = $2 AND status NOT IN ('done', 'cancelled')`,
        [next.task_id, target.space_id],
      );
      await withdrawQueuedTaskMessages(client, target.space_id, [next.task_id]);
      return { advanced: false, reason: "task_budget_exhausted" };
    }

    const policy = taskRow.policy_json && typeof taskRow.policy_json === "object" && !Array.isArray(taskRow.policy_json)
      ? taskRow.policy_json as Record<string, unknown>
      : {};
    const budgetSources: RunBudgetSource[] = [
      {
        source: { kind: "task", id: next.task_id },
        precedence: typeof policy.budget_precedence === "number" ? policy.budget_precedence : null,
        max_runs: taskRow.max_runs,
        max_cost: taskRow.max_cost,
        max_duration_seconds: taskRow.max_duration_seconds,
        max_attempts: typeof policy.max_attempts === "number" && Number.isInteger(policy.max_attempts) && policy.max_attempts > 0
          ? policy.max_attempts
          : null,
      },
      ...budgetSourcesFromPolicy(policy.budget_sources),
    ];
    try {
      await assertBudgetSourcesAvailable(client, target.space_id, budgetSources);
    } catch (error) {
      // Keep the message queued when an inherited Automation/Workflow cap was
      // consumed while it waited behind another Run. The next explicit retry
      // can advance it after the governing budget changes.
      if (error instanceof RunBudgetExceededError) {
        return { advanced: false, reason: "task_budget_exhausted" };
      }
      throw error;
    }

    const { runId } = await createAndQueueRun(client, {
      spaceId: target.space_id,
      projectId: target.project_id,
      projectFolderId: target.project_folder_id,
      workspaceLocationId: target.location_id,
      trustMode: target.execution_host_kind === "server" ? "sandboxed" : "trusted_host",
      threadId: freshThread.id,
      taskId: next.task_id,
      adapterType: freshThread.adapter_type,
      prompt: next.prompt,
      resumeSessionId: freshThread.vendor_session_id,
      userId: next.created_by_user_id,
      // Resolved and validated when the message was enqueued, not now: a host
      // default edited while this message waited its turn must not change what
      // it runs against.
      modelProviderId: next.model_provider_id,
      model: next.model,
      reasoningEffort: next.reasoning_effort,
      agent,
      contractSnapshot: {
        source: { kind: "task", id: next.task_id },
        project_id: target.project_id,
        project_folder_id: target.project_folder_id,
        risk_level: null,
        max_runs: taskRow.max_runs,
        max_cost: taskRow.max_cost,
        max_duration_seconds: taskRow.max_duration_seconds,
        budget_precedence: typeof policy.budget_precedence === "number" ? policy.budget_precedence : null,
        budget_sources: budgetSources,
      },
      timeoutMs: timeoutMsForNewMessage?.messageId === next.id ? timeoutMsForNewMessage.timeoutMs : null,
    });
    await messages.markDispatched(next.id, runId);
    return { advanced: true, run_id: runId, message_id: next.id };
    }
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
  workspaceLocationId: string;
  trustMode: "sandboxed" | "trusted_host";
  threadId: string;
  taskId: string;
  adapterType: string;
  prompt: string;
  resumeSessionId: string | null;
  userId: string;
  modelProviderId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agent: { id: string; current_version_id: string };
  contractSnapshot: Parameters<typeof createRunContractSnapshot>[0];
  timeoutMs: number | null;
}): Promise<{ runId: string }> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  const contractSnapshot = createRunContractSnapshot(params.contractSnapshot, now);
  await db.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       project_id, project_folder_id, workspace_location_id, trust_mode, host_task_thread_id, adapter_type, required_sandbox_level, contract_snapshot_json,
       prompt, owner_user_id, instructed_by_user_id, model_provider_id, model_override_json, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'system', 'manual', 'queued', 'live',
       $5, $6, $7, $8, $9, $10, 'none', $11::jsonb,
       $12, $13, $13, $15, $16::jsonb, $14, $14
     )`,
    [
      runId,
      params.spaceId,
      params.agent.id,
      params.agent.current_version_id,
      params.projectId,
      params.projectFolderId,
      params.workspaceLocationId,
      params.trustMode,
      params.threadId,
      params.adapterType,
      JSON.stringify(contractSnapshot),
      params.prompt,
      params.userId,
      now,
      params.modelProviderId,
      // `source: "request"` — this model came from the dispatch request or the
      // host default it resolved to, not from a routing decision. Without it
      // the Run read model normalizes to "none" and shows a chosen model with
      // no provenance.
      params.model || params.reasoningEffort
        ? JSON.stringify({
            ...(params.model ? { model: params.model } : {}),
            // Beside the model, never inside it: a model id can carry brackets
            // of its own, so the pair cannot be recovered from one string.
            ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
            source: "request",
          })
        : null,
    ],
  );
  // D4: the Run this thread just produced belongs to whichever Task its
  // enqueued message named (`host_thread_messages.task_id`) — mirrors
  // `PgTaskRepository.createTaskRun`'s own `task_runs` insert exactly,
  // including the same `ON CONFLICT (task_id, run_id) DO NOTHING`
  // idempotency, so the two Run-creation paths stay a single invariant
  // rather than two independently-maintained copies of it.
  await db.query(
    `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at)
     VALUES ($1, $2, $3, $4, 'primary', $5)
     ON CONFLICT (task_id, run_id) DO NOTHING`,
    [randomUUID(), params.spaceId, params.taskId, runId, now],
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
