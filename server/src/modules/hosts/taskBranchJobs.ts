import { HostTaskRunSettleFrameSchema } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { JobDeferredError, type JobHandlerRegistry } from "../jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import type { Queryable } from "../routeUtils/common.js";
import { runInProgressSql } from "../tasks/executionRuns.js";
import { sharedHostConnectionRegistry, type HostConnectionRegistry, type HostRequestPayload } from "./connectionRegistry.js";
import {
  deferForHostAnswer,
  loadTaskLocation,
  owedSettleSql,
  TASK_BRANCH_DELETE_JOB,
  TASK_RUN_SETTLE_JOB,
  taskBranchRequestRetryable,
  taskLocationUsable,
  taskWorkspace,
} from "./taskBranchRequests.js";
import { enqueueLateTaskMerge, UNDER_WAY_MERGE_STATUSES } from "./taskMerges.js";

/**
 * The Task branch requests that must reach a host that may be offline when
 * they are due (ADR 0016 §11), as durable jobs:
 *
 * - `task_branch_delete` — a cancelled or deleted Task's branch and worktree
 *   are removed from every Location its execution Runs worked on, one job per
 *   Location, enqueued in the transaction that ends the Task;
 * - `task_run_settle` — a Run's settle that did not get an answer (host
 *   offline, no reply, or the Task busy on the host) is retried until it does,
 *   and the answer is written to the Run's `output_json.result.task_branch`.
 *   Settle is idempotent per Run on the daemon, so a retry of one that did run
 *   answers with what it did.
 *
 * An unavailable host defers a job without spending an attempt, and a host's
 * `hello` brings its deferred jobs forward (`wakeTaskBranchJobs`), so they run
 * on reconnect rather than on the next poll. What these share with the merge
 * lives in `taskBranchRequests.ts`.
 */
const LIVE_RUN_RETRY_MS = 30_000;

export async function enqueueTaskBranchDeletes(
  db: Queryable,
  input: { spaceId: string; userId: string; taskId: string },
): Promise<void> {
  const locations = await db.query<{ workspace_location_id: string; execution_host_id: string }>(
    `SELECT DISTINCT r.workspace_location_id, wl.execution_host_id
       FROM task_runs tr
       JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
       JOIN workspace_locations wl ON wl.id = r.workspace_location_id AND wl.space_id = r.space_id
      WHERE tr.space_id = $1
        AND tr.task_id = $2
        AND r.run_type = 'agent'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.job_type = '${TASK_BRANCH_DELETE_JOB}'
             AND j.status IN ('pending', 'claimed', 'running')
             AND j.payload_json->>'task_id' = $2
             AND j.payload_json->>'workspace_location_id' = r.workspace_location_id
        )`,
    [input.spaceId, input.taskId],
  );
  const queue = new PgJobQueueRepository(db);
  for (const location of locations.rows) {
    await queue.enqueue({
      job_type: TASK_BRANCH_DELETE_JOB,
      space_id: input.spaceId,
      user_id: input.userId,
      payload: {
        task_id: input.taskId,
        workspace_location_id: location.workspace_location_id,
        host_id: location.execution_host_id,
      },
    });
  }
}

/**
 * A settle the host did not answer, owed until it does. Delayed a minute so
 * the Run's own terminal publication, which writes `output_json`, lands first;
 * the handler also waits for it.
 */
export async function enqueueTaskRunSettleRetry(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string | null;
    runId: string;
    taskId: string;
    hostId: string;
    frame: HostRequestPayload<"task_run_settle">;
  },
): Promise<void> {
  await new PgJobQueueRepository(db).enqueue({
    job_type: TASK_RUN_SETTLE_JOB,
    space_id: input.spaceId,
    user_id: input.userId,
    payload: {
      run_id: input.runId,
      task_id: input.taskId,
      workspace_location_id: input.frame.workspace.workspace_location_id,
      host_id: input.hostId,
      frame: input.frame,
    },
    scheduled_at: new Date(Date.now() + 60_000),
  });
}

/** A host is back: its waiting Task branch jobs run now rather than at their next poll. */
export async function wakeTaskBranchJobs(db: Queryable, hostId: string): Promise<void> {
  await db.query(
    `UPDATE jobs SET scheduled_at = now(), updated_at = now()
      WHERE job_type IN ('${TASK_BRANCH_DELETE_JOB}', '${TASK_RUN_SETTLE_JOB}')
        AND status = 'pending'
        AND payload_json->>'host_id' = $1
        AND scheduled_at > now()`,
    [hostId],
  );
}

export function registerTaskBranchJobHandlers(
  registry: JobHandlerRegistry,
  config: ServerConfig,
  hosts: HostConnectionRegistry = sharedHostConnectionRegistry,
): void {
  if (!config.databaseUrl) return;
  registry.register(TASK_RUN_SETTLE_JOB, async (job) => {
    const runId = stringValue(job.payload.run_id);
    const hostId = stringValue(job.payload.host_id);
    const parsed = HostTaskRunSettleFrameSchema.omit({ type: true, request_id: true }).safeParse(job.payload.frame);
    if (!runId || !hostId || !parsed.success) throw new Error(`${TASK_RUN_SETTLE_JOB} requires run_id, host_id and a settle frame`);
    const db = getDbPool(config.databaseUrl!);
    const run = await db.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1 AND space_id = $2`, [runId, job.space_id]);
    if (!run.rows[0]) return { skipped: "run_gone" };
    // The Run's own publication writes `output_json`; recording before it
    // would be overwritten.
    if (run.rows[0].status === "running" || run.rows[0].status === "cancelling") {
      throw new JobDeferredError("The Run has not published its outcome yet", LIVE_RUN_RETRY_MS);
    }
    // A Location or host gone for good will never answer; the owed settle
    // must not hold the Task's next Run forever.
    const location = await loadTaskLocation(db, parsed.data.workspace.workspace_location_id, job.space_id);
    let record: { branch: string | null; commit: string | null; error: string | null };
    if (!taskLocationUsable(location)) {
      record = { branch: null, commit: null, error: "location_unavailable" };
    } else {
      const reply = await hosts.requestTaskBranch(hostId, "task_run_settle", parsed.data);
      if (!reply.ok && taskBranchRequestRetryable(reply.error)) throw deferForHostAnswer(reply.error);
      record = reply.ok
        ? { branch: reply.branch, commit: reply.commit, error: null }
        : { branch: reply.branch, commit: null, error: reply.error ?? "task_run_settle_failed" };
    }
    // The Run never ran in the Task worktree: nothing to record.
    if (!record.branch && !record.commit && !record.error) return { skipped: "no_task_worktree" };
    await db.query(
      `UPDATE runs
          SET output_json = jsonb_set(COALESCE(output_json, '{}'::jsonb), '{result,task_branch}', $3::jsonb, true)
        WHERE id = $1 AND space_id = $2 AND output_json ? 'result'`,
      [runId, job.space_id, JSON.stringify(record)],
    );
    const taskId = stringValue(job.payload.task_id);
    if (record.commit && taskId) {
      await enqueueLateTaskMerge(db, {
        spaceId: job.space_id,
        taskId,
        runId,
        workspaceLocationId: parsed.data.workspace.workspace_location_id,
        requestedByUserId: job.user_id ?? null,
      });
    }
    return record;
  });
  registry.register(TASK_BRANCH_DELETE_JOB, async (job) => {
    const taskId = stringValue(job.payload.task_id);
    const locationId = stringValue(job.payload.workspace_location_id);
    if (!taskId || !locationId) throw new Error(`${TASK_BRANCH_DELETE_JOB} requires task_id and workspace_location_id`);
    const db = getDbPool(config.databaseUrl!);
    // Reopened since: its branch is its work again.
    const task = await db.query<{ status: string; deleted_at: unknown }>(
      `SELECT status, deleted_at FROM tasks WHERE id = $1 AND space_id = $2`,
      [taskId, job.space_id],
    );
    const row = task.rows[0];
    if (row && row.status !== "cancelled" && row.deleted_at == null) return { skipped: "task_reopened" };
    // Revoking a host leaves its Locations as they were; it will never answer.
    const location = await loadTaskLocation(db, locationId, job.space_id);
    if (!taskLocationUsable(location)) return { skipped: "location_unavailable" };
    const live = await db.query(
      `SELECT 1
         FROM task_runs tr
         JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
        WHERE tr.space_id = $1 AND tr.task_id = $3
          AND r.workspace_location_id = $2 AND r.run_type = 'agent'
          AND (
            ${runInProgressSql("r")}
            -- A queued Run nobody dispatched would hold the delete forever.
            OR (r.status = 'queued' AND EXISTS (
              SELECT 1 FROM jobs aj
               WHERE aj.job_type = 'agent_run'
                 AND aj.status IN ('pending', 'claimed', 'running')
                 AND aj.payload_json->>'run_id' = r.id
            ))
          )
       UNION ALL
       SELECT 1 WHERE ${owedSettleSql("$3", "$2")}
       UNION ALL
       -- A merge still under way gives its rebase back first (it sees the
       -- Task is no longer done and aborts on the host).
       SELECT 1 FROM task_merges m
        WHERE m.space_id = $1 AND m.task_id = $3 AND m.workspace_location_id = $2
          AND m.status = ANY($4::text[])
       LIMIT 1`,
      [job.space_id, locationId, taskId, UNDER_WAY_MERGE_STATUSES],
    );
    if ((live.rowCount ?? live.rows.length) > 0) {
      throw new JobDeferredError("A Run of this Task has not ended on this Location", LIVE_RUN_RETRY_MS);
    }
    const workspace = taskWorkspace(location, taskId, config.workspaceRoot);
    if (!workspace) return { skipped: "location_unresolvable" };
    const reply = await hosts.requestTaskBranch(location.execution_host_id, "task_branch_delete", { workspace });
    if (reply.ok) return { deleted: reply.deleted };
    if (taskBranchRequestRetryable(reply.error)) throw deferForHostAnswer(reply.error);
    throw new Error(reply.error ?? "task_branch_delete_failed");
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
