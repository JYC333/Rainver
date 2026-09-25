import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { RunMaterializationService } from "./materializationService.js";
import type { RunOrchestrationService } from "./orchestrationService.js";
import { PgRunRepository } from "./repository.js";
import { buildRunOrchestration } from "./orchestrationFactory.js";
import {
  JobDeferredError,
  type JobEnvelopeForHandler,
  type JobHandlerRegistry,
} from "../jobs/handlerRegistry.js";
import type { JobHandlerResult } from "../jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { finalizeChatTurn } from "./chatTurnFinalizer.js";
import { recordHostThreadOutcome } from "../hosts/threadOutcome.js";
import { hostThreadDispatchInputs } from "../hosts/threadDispatchInputs.js";
import { protocolRunStatus } from "./orchestrationResults.js";
import { withDbTransaction } from "../routeUtils/common.js";
import {
  DRAINED_TRIGGER_ORIGINS,
  INSTANCE_UPDATE_PENDING,
  instanceUpdatePending,
} from "../deployment/drainAdmission.js";
import { effectiveRunTrigger } from "../systemActions/effectiveRunTrigger.js";
import { enqueueRunTerminalReconcilers } from "./runTerminalReconcilers.js";
import { executionTaskId, taskMergeIdOf } from "./remoteHostCliAdapter.js";
import { runInProgressSql } from "../tasks/executionRuns.js";
import { owedSettleSql } from "../hosts/taskBranchRequests.js";
import { UNDER_WAY_MERGE_STATUSES } from "../hosts/taskMerges.js";
import type { RunRecord } from "./runRepositoryTypes.js";
import type { Queryable } from "../routeUtils/common.js";

export function registerAgentRunHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;

  const { repository, orchestration, materializer } = buildRunOrchestration(config);

  registry.register("agent_run", async (job) =>
    handleAgentRun(job, orchestration, materializer, repository, config));
  registry.register("authorization_request_reconcile", async (job) =>
    reconcileAuthorizationRequest(job, orchestration, repository, config));
}

async function reconcileAuthorizationRequest(
  job: JobEnvelopeForHandler,
  orchestration: RunOrchestrationService,
  repository: PgRunRepository,
  config: ServerConfig,
): Promise<JobHandlerResult> {
  const requestId = stringValue(job.payload.authorization_request_id);
  const runId = stringValue(job.payload.run_id);
  if (!requestId || !runId || !config.databaseUrl) {
    throw new Error("authorization_request_reconcile requires authorization_request_id and run_id");
  }
  const db = getDbPool(config.databaseUrl);
  const request = await db.query<{
    status: "approved" | "rejected";
    agent_id: string;
    instructed_by_user_id: string;
    decided_by_user_id: string;
  }>(
    `SELECT status, agent_id, instructed_by_user_id, decided_by_user_id
       FROM authorization_requests
      WHERE id = $1 AND run_id = $2 AND space_id = $3
        AND status IN ('approved', 'rejected')
      LIMIT 1`,
    [requestId, runId, job.space_id],
  );
  const decided = request.rows[0];
  if (!decided) throw new Error("Decided authorization request not found");

  if (decided.status === "rejected") {
    const result = await orchestration.cancelRun({
      run_id: runId,
      space_id: job.space_id,
      requested_by_user_id: decided.decided_by_user_id,
      reason: "Agent authorization request was rejected.",
    });
    if (result.error_code === "finalization_failed") {
      throw new Error(
        result.error ?? "Authorization rejection finalization failed.",
      );
    }
    const terminal = await repository.getRun(job.space_id, runId);
    if (terminal) await finalizeChatTurn(config, repository, terminal);
    return result;
  }

  const reconciliation = await withDbTransaction(db, async (client) => {
    const runs = new PgRunRepository(client);
    const queue = new PgJobQueueRepository(client);
    const updated = await runs.requeueApprovedAuthorizationRequest({
      run_id: runId,
      space_id: job.space_id,
      authorization_request_id: requestId,
      resumed_at: new Date().toISOString(),
    });
    const current = updated ?? await runs.getRun(job.space_id, runId);
    if (current?.status === "queued") {
      await queue.ensureAgentRunJob({
        job_type: "agent_run",
        space_id: job.space_id,
        user_id: decided.instructed_by_user_id,
        agent_id: decided.agent_id,
        project_folder_id: current.project_folder_id,
        payload: { run_id: runId },
      });
    }
    return { updated, current };
  });
  if (!reconciliation.updated) {
    if (
      reconciliation.current
      && reconciliation.current.status !== "waiting_for_review"
    ) {
      return {
        run_id: runId,
        status: reconciliation.current.status,
        reconciled: true,
      };
    }
    const exponent = Math.max(0, Math.min(6, job.attempts - 1));
    throw new JobDeferredError(
      "Run execution lock has not been released for authorization reconciliation",
      Math.min(30_000, 500 * (2 ** exponent)),
    );
  }
  return { run_id: runId, status: "queued", reconciled: true };
}

async function handleAgentRun(
  job: JobEnvelopeForHandler,
  orchestration: RunOrchestrationService,
  materializer: RunMaterializationService,
  repository: PgRunRepository,
  config: ServerConfig,
): Promise<JobHandlerResult> {
  const runId = stringValue(job.payload.run_id);
  if (!runId) {
    throw new Error(
      "agent_run payload requires run_id under the server runs authority; " +
        "task_id/agent_id create-and-execute payloads are not supported",
    );
  }
  if (!job.user_id) {
    throw new Error("agent_run job requires user_id");
  }
  // Which host thread this Run belongs to and which vendor session it resumes
  // are read from the Run itself, never from the payload: twenty places
  // enqueue this job and most of them do not know they are re-dispatching a
  // thread-bound Run (the supervisor retry, an authorization re-enqueue, the
  // resume endpoint, direct chat). See `hostThreadDispatchInputs`.
  const queuedRun = await repository.getRun(job.space_id, runId);
  // ADR 0020 section 4: the drain has to converge, so an unattended Run does
  // not start while an instance update is queued or draining. Deferring keeps
  // the retry budget intact (`deferJob` gives the attempt back), so this is a
  // wait, never a failed Run. Conversation-originated Runs are unaffected.
  // The origin is read one hop up for a delegated Run: a child of an unattended
  // root is unattended work too, and reading the raw column would make one hop
  // of `agent.delegate` a way past the drain. The parent is parked in
  // `waiting_for_dependency` while its child runs, so it is not counted by the
  // drain and deferring the child does not stall it.
  if (queuedRun && await instanceUpdatePending(config)) {
    const { origin } = await effectiveRunTrigger(getDbPool(config.databaseUrl!), queuedRun);
    if (DRAINED_TRIGGER_ORIGINS.has(origin)) {
      throw new JobDeferredError(INSTANCE_UPDATE_PENDING, 30_000);
    }
  }
  // ADR 0016 §11: a Task's execution Runs share its worktree and branch, so
  // they run one at a time — a later one waits for the earlier one to end,
  // including while that one is parked on a review or a delegated Agent. The
  // daemon also queues two launches of one Task, which covers the moment
  // both pass this check; this is what keeps a parked Run's worktree from
  // being taken over. Deferring keeps the retry budget intact.
  // Only a Run not yet admitted waits: a `running` one whose job was
  // reclaimed after a worker died has already taken its turn, and holding it
  // could leave it and the Run it waits for waiting on each other.
  if (queuedRun?.status === "queued" && await taskRunAhead(getDbPool(config.databaseUrl!), queuedRun)) {
    throw new JobDeferredError(TASK_RUN_AHEAD, 30_000);
  }
  const hostThread = hostThreadDispatchInputs(queuedRun ?? { host_task_thread_id: null, model_override_json: null });
  let result: Awaited<ReturnType<RunOrchestrationService["executeRun"]>>;
  try {
    result = await orchestration.executeRun({
      run_id: runId,
      space_id: job.space_id,
      worker_id: job.worker_id,
      job_id: job.job_id,
      command_source: "job",
      // control-center-phase2-plan.md P1: the hosts dispatch endpoint no
      // longer calls executeRun synchronously — it enqueues this job instead
      // (async dispatch) and carries the requested timeout here (dropped
      // silently by the P1 migration until discovery review caught it — no
      // other agent_run job carries timeout_ms today). The vendor session to
      // resume comes from the Run, above, so a retry keeps it.
      adapter_config: {
        ...recordValue(job.payload.adapter_config),
        ...(hostThread.resume_session_id ? { remote_resume_session_id: hostThread.resume_session_id } : {}),
      },
      timeout_ms: numberValue(job.payload.timeout_ms),
    });
  } catch (error) {
    if (job.attempts >= job.max_attempts) {
      const current = await repository.getRun(job.space_id, runId);
      const terminal = current && isTerminalRun(current.status)
        ? current
        : await repository.markRunTerminal({
            run_id: runId,
            space_id: job.space_id,
            status: "orphaned",
            output_json: {},
            error_json: {
              error_code: "job_exhausted",
              error_text: error instanceof Error
                ? error.message
                : "The agent_run job exhausted its retry budget.",
            },
            exit_code: 1,
            completed_at: new Date().toISOString(),
          });
      if (terminal) {
        const finalization = await materializer.finalizeRun(terminal);
        if (finalization.status === "succeeded") {
          const currentTerminal = await repository.getRun(job.space_id, runId);
          if (currentTerminal && isTerminalRun(currentTerminal.status)) {
            await orchestration.reconcileTerminalDelegation(currentTerminal);
            if (hostThread.thread_id) {
              await recordHostThreadOutcome(
                config,
                hostThread.thread_id,
                currentTerminal,
                hostThread.resume_attempted,
                hostThread.identity,
              );
            }
            await finalizeChatTurn(config, repository, currentTerminal);
          }
        }
      }
    }
    throw error;
  }
  let completedRun = await repository.getRun(job.space_id, runId);
  if (completedRun && isTerminalRun(completedRun.status)) {
    const finalization = await materializer.finalizeRun(completedRun);
    if (finalization.status !== "succeeded") {
      throw new Error(
        finalization.error_message ?? "Run finalization reconciliation failed.",
      );
    }
    completedRun = await repository.getRun(job.space_id, runId);
    if (completedRun) {
      result = { ...result, status: protocolRunStatus(completedRun.status) };
    }
  }
  if (completedRun && isTerminalRun(completedRun.status)) {
    await orchestration.reconcileTerminalDelegation(completedRun);
  }
  // control-center-phase2-plan.md P1: the hosts dispatch endpoint now
  // enqueues this job instead of awaiting executeRun inline, so task-thread
  // outcome recording (vendor session id, session_reset detection) has to
  // happen here instead, gated on the run actually carrying a thread.
  // Before chat finalization on purpose: releasing the thread's dispatch
  // lock must not depend on message materialization succeeding.
  if (completedRun && isTerminalRun(completedRun.status) && hostThread.thread_id) {
    await recordHostThreadOutcome(
      config,
      hostThread.thread_id,
      completedRun,
      hostThread.resume_attempted,
      hostThread.identity,
    );
  }
  if (completedRun) {
    await finalizeChatTurn(config, repository, completedRun);
  }
  // Research runs use the normal Run/Materialization authority. This hook is
  // only a latency optimization: the reconciler observes the committed run
  // and advances the owning Project Research operation.
  if (result.status === "succeeded" || result.status === "failed" || result.status === "degraded" || result.status === "cancelled") {
    const db = getDbPool(config.databaseUrl!);
    const contract = await db.query<{ workflow_input_json: unknown }>(
      `SELECT contract_snapshot_json->'workflow_input_json' AS workflow_input_json
         FROM runs WHERE id=$1 AND space_id=$2`,
      [runId, job.space_id],
    );
    await enqueueRunTerminalReconcilers(db, {
      space_id: job.space_id,
      user_id: job.user_id,
      run_id: runId,
      workflow_input_json: recordValue(contract.rows[0]?.workflow_input_json),
    });
  }
  return result;
}

const TASK_RUN_AHEAD = "Another execution Run of this Task is still in progress";

/**
 * Whether this Run must wait for another execution Run of the same Task on
 * the same Location: one that has started and not ended (a failed Run a
 * supervisor holds for review has ended — it was settled, and a person
 * deciding on it must not stall the Task), one queued with a live job that
 * comes first — a Run that already started (a parked Run resuming keeps its
 * `started_at`) before one that has not, then by admission — or one whose
 * settle is still owed to its host (a `task_run_settle` retry job), or while
 * a merge of the Task holds its worktree. The queued clause is what makes two
 * Runs checking at once agree on an order.
 */
export async function taskRunAhead(db: Queryable, run: RunRecord): Promise<boolean> {
  const taskId = executionTaskId(run);
  if (!taskId || !run.workspace_location_id) return false;
  // A merge's resolution Run waits for nothing: its merge already waited for
  // every Run that started, and a queued one waits for the merge — holding
  // this Run behind that one would have each wait for the other.
  if (taskMergeIdOf(run)) return false;
  const result = await db.query(
    `SELECT 1
       FROM task_runs tr
       JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
       JOIN runs self ON self.id = $2 AND self.space_id = $1
      WHERE tr.space_id = $1
        AND tr.task_id = $4
        AND r.id <> $2
        AND r.workspace_location_id = $3
        AND r.run_type = 'agent'
        AND r.required_sandbox_level <> 'read_only'
        AND (
          ${runInProgressSql("r")}
          OR (
            r.status = 'queued'
            AND (r.started_at IS NULL, r.created_at, r.id) < (self.started_at IS NULL, self.created_at, self.id)
            AND EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.job_type = 'agent_run'
                 AND j.status IN ('pending', 'claimed', 'running')
                 AND j.payload_json->>'run_id' = r.id
            )
          )
        )
     UNION ALL
     SELECT 1 WHERE ${owedSettleSql("$4", "$3")}
     UNION ALL
     -- A merge in progress holds the worktree. A Run that already started and
     -- is resuming (from a delegated Agent or a review) goes on: the merge
     -- waits for it (\`taskBusyOnLocation\`), so it cannot be past \`queued\`.
     SELECT 1 FROM task_merges m
      JOIN runs self ON self.id = $2 AND self.space_id = $1
      WHERE m.space_id = $1 AND m.task_id = $4 AND m.workspace_location_id = $3
        AND m.status = ANY($5::text[])
        AND self.started_at IS NULL
     LIMIT 1`,
    [run.space_id, run.id, run.workspace_location_id, taskId, UNDER_WAY_MERGE_STATUSES],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export async function enqueueAgentRunJob(
  config: ServerConfig,
  input: {
    run_id: string;
    space_id: string;
    user_id: string;
    agent_id?: string | null;
    project_folder_id?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error("enqueueAgentRunJob requires SERVER_DATABASE_URL");
  }
  const queue = new PgJobQueueRepository(getDbPool(config.databaseUrl));
  await queue.enqueue({
    job_type: "agent_run",
    space_id: input.space_id,
    user_id: input.user_id,
    agent_id: input.agent_id ?? null,
    project_folder_id: input.project_folder_id ?? null,
    payload: {
      run_id: input.run_id,
      ...(input.payload ?? {}),
    },
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isTerminalRun(status: string): boolean {
  return [
    "succeeded",
    "failed",
    "degraded",
    "cancelled",
    "orphaned",
  ].includes(status);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
