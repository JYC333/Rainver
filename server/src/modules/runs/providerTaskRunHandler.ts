import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";
import {
  JobDeferredError,
  type JobEnvelopeForHandler,
  type JobHandlerRegistry,
  type JobHandlerResult,
} from "../jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { JobEffectLeaseLost, withJobEffectAuthority } from "../jobs/effectAuthority.js";
import {
  DRAINED_TRIGGER_ORIGINS,
  INSTANCE_UPDATE_PENDING,
  instanceUpdatePending,
} from "../deployment/drainAdmission.js";
import { effectiveRunTrigger } from "../systemActions/effectiveRunTrigger.js";
import { PgRunRepository, type RunRecord } from "./repository.js";
import {
  failBoundedProviderTaskRunUnderClaim,
  runBoundedProviderTask,
  type BoundedProviderTaskInput,
} from "./boundedProviderTaskRun.js";
import { enqueueRunTerminalReconcilers } from "./runTerminalReconcilers.js";

export const PROVIDER_TASK_RUN_JOB_TYPE = "provider_task_run";

/**
 * A bounded ProviderTask Run performed by the job worker.
 *
 * The counterpart of `agent_run` for the other `execution_kind`: the request
 * path admits the Run, makes it durable `queued` and enqueues this job, and
 * the worker performs the bounded call. Doing it on the request path gives
 * the task no worker retry, no drain admission, and no recovery: a crash
 * between the provider answering and its output being applied leaves a Run
 * nobody will finish.
 *
 * The handler knows nothing about any domain's prompt. It loads the Run and
 * its frozen contract and asks the owning domain, through this registry, to
 * rebuild the bounded request from them.
 */
interface ProviderTaskRunContext {
  db: Queryable;
  config: ServerConfig;
  run: RunRecord;
  job: JobEnvelopeForHandler;
}

/**
 * Builds the bounded request for one kind of ProviderTask Run out of the Run's
 * own durable record. It must read the contract, never the job payload: the
 * payload carries the Run id and nothing else, so a replayed or reclaimed job
 * cannot change what the task does.
 */
type ProviderTaskRunPreparer = (
  context: ProviderTaskRunContext,
) => Promise<Omit<BoundedProviderTaskInput, "runId" | "failRunOnError"> & {
  /**
   * The task may send and settle only while this worker still holds the Job's
   * claim. The handler records the Job's one-attempt start fence (reclaim then
   * fails the Job as outcome-unknown instead of repeating it) and binds the
   * Job's effect authority around the task, so the domain's send fence and
   * settlement lock the current claim: a worker that lost it sends nothing
   * and writes nothing, and the Run is left to the claim's current owner.
   */
  claimBound?: true;
}>;

class ProviderTaskRunRegistry {
  private readonly preparers = new Map<string, ProviderTaskRunPreparer>();

  /**
   * Keyed by the Run's `capability_id` — the bounded task's own identity.
   *
   * Replaces rather than refuses: this registry is process-global while the
   * job handler registry is rebuilt per worker (and per test), so the same
   * domain re-registers the same preparer every time one is built.
   */
  register(capabilityId: string, preparer: ProviderTaskRunPreparer): void {
    this.preparers.set(capabilityId, preparer);
  }

  get(capabilityId: string | null): ProviderTaskRunPreparer | undefined {
    return capabilityId ? this.preparers.get(capabilityId) : undefined;
  }

  /** Test seam: the registry is process-wide and handlers register at boot. */
  reset(): void {
    this.preparers.clear();
  }
}

export const providerTaskRunPreparers = new ProviderTaskRunRegistry();

export function registerProviderTaskRunHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  registry.register(PROVIDER_TASK_RUN_JOB_TYPE, async (job) => handleProviderTaskRun(job, config));
}

export async function enqueueProviderTaskRunJob(
  db: Queryable,
  input: { run_id: string; space_id: string; user_id: string; project_id?: string | null; max_attempts?: number },
): Promise<{ id: string; status: string }> {
  const job = await new PgJobQueueRepository(db).enqueue({
    job_type: PROVIDER_TASK_RUN_JOB_TYPE,
    space_id: input.space_id,
    user_id: input.user_id,
    payload: { run_id: input.run_id },
    max_attempts: input.max_attempts,
  });
  return { id: job.id, status: job.status };
}

async function handleProviderTaskRun(
  job: JobEnvelopeForHandler,
  config: ServerConfig,
): Promise<JobHandlerResult> {
  const runId = typeof job.payload.run_id === "string" && job.payload.run_id.trim()
    ? job.payload.run_id
    : null;
  if (!runId) throw new Error("provider_task_run payload requires run_id");
  if (!job.user_id) throw new Error("provider_task_run job requires user_id");
  const db = getDbPool(config.databaseUrl!);
  const repository = new PgRunRepository(db);
  const run = await repository.getRun(job.space_id, runId);
  if (!run) throw new Error(`provider_task_run Run '${runId}' not found`);
  if (run.execution_kind !== "provider_task") {
    throw new Error(`Run '${runId}' is not a provider_task Run`);
  }
  // Settled or being stopped: a reclaimed job whose predecessor finished, or a
  // Run a person cancelled while it sat queued. Either way there is nothing
  // left to do, and starting the task would spend the provider on work that
  // has already been called off.
  if (isTerminalRun(run.status) || run.status === "cancelling") {
    // The terminal reconcilers are enqueued here too, not only after this
    // handler settles the Run. A retry that finds the Run already terminal
    // must still reach them: they are idempotent on the Run, and a nudge lost
    // to a failed enqueue is otherwise never retried.
    if (isTerminalRun(run.status)) {
      await enqueueRunTerminalReconcilers(db, {
        space_id: job.space_id,
        user_id: job.user_id,
        run_id: runId,
        workflow_input_json: workflowInput(run),
      });
    }
    return { run_id: runId, status: run.status, skipped: true };
  }
  // ADR 0020 §4, the same gate `agent_run` applies and for the same reason:
  // deferring returns the attempt, so an instance update never fails bounded
  // work, it only makes it wait. A Run a person is waiting on is unaffected.
  if (await instanceUpdatePending(config)) {
    const { origin } = await effectiveRunTrigger(db, run);
    if (DRAINED_TRIGGER_ORIGINS.has(origin)) {
      throw new JobDeferredError(INSTANCE_UPDATE_PENDING, 30_000);
    }
  }

  const preparer = providerTaskRunPreparers.get(run.capability_id ?? null);
  if (!preparer) {
    // Nothing can perform this Run, and no number of retries will change
    // that — settle it rather than leaving a queued Run in the list forever.
    // Only under this worker's current claim: a reclaimed Job's owner settles.
    await failBoundedProviderTaskRunUnderClaim(db, job.space_id, runId, {
      code: "provider_task_kind_unregistered",
      message: `No bounded ProviderTask is registered for capability '${run.capability_id ?? "(none)"}'.`,
    }, job);
    return { run_id: runId, status: "failed", error_code: "provider_task_kind_unregistered" };
  }

  // Everything from here on is inside the exhaustion guard, the same shape
  // `agent_run` uses: `runBoundedProviderTask` settles the Run for a provider
  // or contract failure, but the preparer itself can throw — a Run missing the
  // provider binding its contract froze can never be rebuilt — and so can the
  // database calls around it. Do not let that throw escape the guard. The Run
  // would stay `queued` after the last attempt and keep spending its domain's
  // daily budget.
  try {
    const { claimBound, ...request } = await preparer({ db, config, run, job });
    const perform = () => runBoundedProviderTask(db, config, {
      ...request,
      runId,
      // The job's own retries come first, exactly as `agent_run` does it: a Run
      // is only settled failed once nothing is left to try, so a transient
      // provider or database failure does not burn the bounded task.
      failRunOnError: job.attempts >= job.max_attempts,
      // Every worker failure terminal, claim-bound or not, is written under this
      // Job's current claim; a reclaimed or cancelled Job's new owner settles.
      failureClaim: job,
    } as BoundedProviderTaskInput);
    let result: Awaited<ReturnType<typeof perform>>;
    if (claimBound) {
      await startClaimBoundEffect(db, job);
      result = await withJobEffectAuthority(db, job, perform);
    } else {
      result = await perform();
    }

    const terminal = await repository.getRun(job.space_id, runId);
    if (terminal && isTerminalRun(terminal.status)) {
      await enqueueRunTerminalReconcilers(db, {
        space_id: job.space_id,
        user_id: job.user_id,
        run_id: runId,
        workflow_input_json: workflowInput(terminal),
      });
    }
    if (!result.ok) {
      // Still retryable: throwing is what gives the job its next attempt.
      if (!terminal || !isTerminalRun(terminal.status)) throw new Error(result.error);
      return { run_id: runId, status: terminal.status, error_code: result.errorCode };
    }
    return { run_id: runId, status: terminal?.status ?? "succeeded" };
  } catch (error) {
    // Another owner holds (or ended) this Job: its reclaim or cancel settles
    // the Run, never this worker.
    if (error instanceof JobEffectLeaseLost) throw error;
    if (job.attempts >= job.max_attempts) {
      const current = await repository.getRun(job.space_id, runId);
      if (current && !isTerminalRun(current.status)) {
        // `failed`, not `agent_run`'s `orphaned`: a bounded ProviderTask Run
        // has one failure terminal, and `orphaned` means a Run that was
        // running when the server lost its execution registry — which a Run
        // the worker never dispatched was not. The error code is the same
        // `job_exhausted` `agent_run` records, so both read alike.
        // Under this worker's current claim, whatever threw (the preparer
        // included, before any claim-bound work started): a worker whose Job
        // was reclaimed or cancelled meanwhile writes nothing.
        try {
          await failBoundedProviderTaskRunUnderClaim(db, job.space_id, runId, {
            code: "job_exhausted",
            message: error instanceof Error
              ? error.message
              : "The provider_task_run job exhausted its retry budget.",
          }, job);
        } catch (settlement) {
          // The claim is no longer this worker's: it writes nothing, and the
          // task's own failure is still what this attempt reports.
          if (settlement instanceof JobEffectLeaseLost) throw error;
          throw settlement;
        }
        const terminal=await repository.getRun(job.space_id,runId);
        if(terminal&&isTerminalRun(terminal.status))await enqueueRunTerminalReconcilers(db,{space_id:job.space_id,user_id:job.user_id,run_id:runId,workflow_input_json:workflowInput(terminal)});
      }
    }
    throw error;
  }
}

/**
 * The claim-conditioned start fence of a claim-bound task, written before any
 * provider attempt. Absent claim, or a fence an earlier attempt already left
 * (its send outcome is unknown), refuses: nothing is sent again.
 */
async function startClaimBoundEffect(db: Queryable, job: JobEnvelopeForHandler): Promise<void> {
  const started = await db.query(
    `UPDATE jobs SET result_json=COALESCE(result_json,'{}'::jsonb)||'{"source_dispatch":"started"}'::jsonb
      WHERE id=$1 AND space_id=$2 AND status='running' AND claimed_by=$3 AND attempts=$4
        AND COALESCE(result_json,'{}'::jsonb)->>'source_dispatch' IS DISTINCT FROM 'started'
      RETURNING id`,
    [job.job_id, job.space_id, job.worker_id, job.attempts],
  );
  if (!started.rows.length) throw new JobEffectLeaseLost("provider_task_run Job does not hold a fresh claim; its task is not sent again");
}

function workflowInput(run: RunRecord): Record<string, unknown> {
  const contract = run.contract_snapshot_json;
  const record = contract && typeof contract === "object" && !Array.isArray(contract)
    ? contract as Record<string, unknown>
    : {};
  const workflow = record.workflow_input_json;
  return workflow && typeof workflow === "object" && !Array.isArray(workflow)
    ? workflow as Record<string, unknown>
    : {};
}

function isTerminalRun(status: string): boolean {
  return ["succeeded", "failed", "degraded", "cancelled", "orphaned"].includes(status);
}
