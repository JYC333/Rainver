import type { Pool } from "../../../db/pool";
import { getDbPool } from "../../../db/pool";
import type { ServerConfig } from "../../../config";
import { optionalString } from "../../routeUtils/common";
import { JobDeferredError, type JobHandlerRegistry, type JobHandlerResult } from "../../jobs/handlerRegistry";
import { buildRunOrchestration } from "../../runs/orchestrationFactory";
import { HARD_TERMINAL_RUN_STATUSES } from "../../runs/orchestrationResults";
import { RESEARCH_OPERATION_CANCEL_JOB } from "../researchOperationCancel";

const CANCEL_CONFIRMATION_RETRY_MS = 10_000;

/** How long to keep re-checking Runs that were told to stop but have not
 * confirmed process exit. Deferring is not free and is not attempt-capped —
 * `PgJobQueueRepository.deferJob` refunds the attempt — so an unbounded
 * retry on a process that never exits would churn every ten seconds forever.
 * A process still alive after this window is not transient, and the run
 * staleness sweeper (`markStaleRunsOrphaned`) is the backstop that takes it
 * to a hard-terminal status; this job reports it and finishes. */
const CANCEL_CONFIRMATION_WINDOW_MS = 5 * 60_000;

const RUN_TERMINAL_SQL_LIST = HARD_TERMINAL_RUN_STATUSES.map((status) => `'${status}'`).join(",");

/**
 * Stops the work a cancelled research Operation still has in flight.
 *
 * A research Operation owns four kinds of live work, and stopping only some
 * of them leaves the user's "stop" partly ignored:
 *
 * - **Runs** — synthesis, revision, critique, monitor comparison, and the pass
 *   root. None of them is a child of the others (`createQueuedRunWithBudgetAdmission`
 *   sets no `root_run_id`), so they are found by the operation id every research
 *   Run stamps into its contract snapshot — the same lookup key
 *   `SynthesisCoordinator` already uses to rebind a lost synthesis Run.
 * - **Screening batch jobs** — `source_post_processing_event` jobs carrying
 *   `recovery_for_operation_id`. Queued in bulk, so a cancel that ignored
 *   them would keep classifying items nobody is waiting for. (A batch a
 *   worker is executing at this moment finishes its in-flight classification
 *   Run — that Run carries no operation id in its contract and is bounded to
 *   one batch, an accepted leak.)
 * - **Source backfill plans** — the acquisition itself, and the expensive
 *   phase. The segment scheduler advances only plans in `approved`/`running`,
 *   and never consults the Operation's status, so without this an Operation
 *   cancelled mid-backfill kept fetching from the provider and ingesting for
 *   as long as the plan lasted.
 * - **The pass Execution** — left `queued`/`running` it stays a live pass
 *   nothing will ever finish.
 *
 * Cancel also resolves the Operation's still-pending checkpoints: pre-reform
 * the checkpoint decision *was* the stop lever, so stopping resolved the row
 * as a side effect; with an independent cancel, a surviving pending gate
 * keeps the web UI advertising a review whose approval would no-op.
 *
 * Everything here is idempotent by construction: `cancelRun` skips Runs that
 * already reached terminal, and every UPDATE is filtered on non-terminal
 * status. Re-running this job after a retry therefore cannot turn a completed
 * Run into a cancelled one, which matters because the Operation row is
 * already `cancelled` before this job is claimed — a Run that finished in
 * that window is a legitimate result, not something to undo.
 */
/** The job is enqueued once per cancel, so its own age is how long ago the
 * user pressed Stop — `attempts` cannot serve here because a defer refunds
 * it. */
async function withinConfirmationWindow(pool: Pool, jobId: string): Promise<boolean> {
  const row = await pool.query<{ created_at: string }>(
    `SELECT created_at FROM jobs WHERE id=$1`,
    [jobId],
  );
  const createdAt = row.rows[0]?.created_at;
  if (!createdAt) return false;
  return Date.now() - new Date(createdAt).getTime() < CANCEL_CONFIRMATION_WINDOW_MS;
}

export function registerResearchOperationCancelHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const pool: Pool = getDbPool(config.databaseUrl);
  const { orchestration } = buildRunOrchestration(config);

  registry.register(RESEARCH_OPERATION_CANCEL_JOB, async (job): Promise<JobHandlerResult> => {
    const operationId = optionalString(job.payload.operation_id);
    const projectId = optionalString(job.payload.project_id);
    const reason = optionalString(job.payload.reason) ?? "The research operation was cancelled.";
    if (!operationId || !projectId) throw new Error(`${RESEARCH_OPERATION_CANCEL_JOB} requires operation_id and project_id`);
    const spaceId = job.space_id;

    // `project_id` narrows the scan to one project's runs (indexed); the JSON
    // predicate alone would walk — and detoast the contract snapshot of —
    // every run in the space. Safe as a filter, not just a hint: every path
    // that creates a research Run sets it — the stage runs from an explicit
    // `projectId` (synthesis/revision/critique in `synthesisCoordinator`,
    // `monitorComparisonService`, `areaService`) and the pass root and node
    // runs from `automation.project_id`, which `findOrCreateResearchAutomation`
    // always binds to the Project. A future creation path that leaves it null
    // would be invisible here, which is why this is worth stating.
    const runs = await pool.query<{ id: string }>(
      `SELECT r.id FROM runs r
        WHERE r.space_id=$1 AND r.project_id=$3
          AND r.contract_snapshot_json->'workflow_input_json'->'project_research'->>'operation_id'=$2
          AND (
            r.status NOT IN (${RUN_TERMINAL_SQL_LIST})
            OR r.status='cancelled'
          )`,
      [spaceId, operationId, projectId],
    );
    let cancelledRuns = 0;
    let unconfirmed = 0;
    const finalizationFailures: string[] = [];
    for (const row of runs.rows) {
      const result = await orchestration.cancelRun({
        run_id: row.id,
        space_id: spaceId,
        requested_by_user_id: job.user_id ?? null,
        reason,
      });
      // `cancelling` means the kill was requested but the child process has
      // not confirmed exit. Counting that as done would complete this job
      // with the process still running and nothing left to ever re-check, so
      // the whole handler retries later instead (every step is idempotent).
      if (result.error_code === "finalization_failed") {
        finalizationFailures.push(`${row.id}: ${result.error ?? "Run finalization failed"}`);
      } else if (result.status === "cancelling") unconfirmed += 1;
      else if (!result.skipped) cancelledRuns += 1;
    }

    // Screening batches are plain queue work with no `agent_run` cascade, so
    // one conditional UPDATE is the entire cancel — mirroring the fields
    // `PgJobQueueRepository.cancelJob` writes, without a round trip per row.
    const now = new Date().toISOString();
    const batches = await pool.query<{ id: string }>(
      `UPDATE jobs
          SET status='cancelled', heartbeat_at=NULL, completed_at=$3, updated_at=$3
        WHERE space_id=$1
          AND job_type='source_post_processing_event'
          AND payload_json->>'recovery_for_operation_id'=$2
          AND status IN ('pending','claimed','running')
        RETURNING id`,
      [spaceId, operationId, now],
    );

    const backfillPlans = await pool.query<{ id: string }>(
      `UPDATE source_backfill_plans
          SET status='cancelled', next_eligible_at=NULL, updated_at=$3
        WHERE space_id=$1 AND project_operation_id=$2
          AND status IN ('draft','proposed','approved','running','paused')
        RETURNING id`,
      [spaceId, operationId, now],
    );

    const executions = await pool.query<{ id: string }>(
      `UPDATE workflow_executions
          SET status='cancelled', ended_at=$3, updated_at=$3
        WHERE space_id=$1 AND research_operation_id=$2 AND status IN ('queued','running')
        RETURNING id`,
      [spaceId, operationId, now],
    );

    const checkpoints = await pool.query<{ id: string }>(
      `UPDATE project_research_checkpoints
          SET status='waived', decision_reason='The research operation was cancelled.',
              decided_at=$3, updated_at=$3
        WHERE space_id=$1 AND status='pending'
          AND machine_result_json->>'operation_id'=$2
        RETURNING id`,
      [spaceId, operationId, now],
    );

    if (unconfirmed > 0 && await withinConfirmationWindow(pool, job.job_id)) {
      throw new JobDeferredError(
        `${unconfirmed} run(s) have not confirmed process exit yet`,
        CANCEL_CONFIRMATION_RETRY_MS,
      );
    }

    // A cancelled row is already hard-terminal, so an ordinary retry would
    // skip it forever. The query above deliberately reselects cancelled Runs;
    // finalization and delegation projection are idempotent, so failing this
    // job preserves the retry until both have actually completed (including a
    // projection failure that happened after the finalization gate committed).
    if (finalizationFailures.length > 0) {
      throw new Error(`Research cancellation finalization failed for ${finalizationFailures.join("; ")}`);
    }

    return {
      operation_id: operationId,
      cancelled_runs: cancelledRuns,
      unconfirmed_runs: unconfirmed,
      cancelled_batches: batches.rows.length,
      cancelled_backfill_plans: backfillPlans.rows.length,
      cancelled_executions: executions.rows.length,
      waived_checkpoints: checkpoints.rows.length,
    };
  });
}
