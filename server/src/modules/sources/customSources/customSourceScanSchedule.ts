import { randomUUID } from "node:crypto";
import type { Queryable } from "../../routeUtils/common.js";
import { listDueSourceChannelScanTasks } from "../sourceConnectionScheduler.js";
import { enqueueChannelScanIfDue, type DueChannelScanRow } from "../scanSchedule.js";

const STUCK_RUN_AFTER_SECONDS = 600;

/**
 * A run stuck at `status='running'` (server crash/restart mid-run, since the
 * sandboxed child process runs outside any DB transaction) would otherwise
 * permanently block its connection from being re-enqueued — the "no
 * in-flight run" dedup check in `enqueueDueCustomSourceHandlerRuns` treats
 * `running` as in-flight forever. Mirrors the generic job queue's
 * `reclaimStuckJobs` (`server/src/modules/jobs/worker.ts`) at the
 * `source_handler_runs` level.
 */
export async function reclaimStuckCustomSourceHandlerRuns(
  db: Queryable,
  stuckAfterSeconds = STUCK_RUN_AFTER_SECONDS,
): Promise<number> {
  const now = new Date().toISOString();
  const stuck = await db.query<{ id: string; extraction_job_id: string | null }>(
    `UPDATE source_handler_runs
        SET status = 'failed', failure_class = 'stuck_reclaimed', completed_at = $1
      WHERE status = 'running'
        AND started_at IS NOT NULL
        AND started_at <= $1::timestamptz - make_interval(secs => $2)
      RETURNING id, extraction_job_id`,
    [now, stuckAfterSeconds],
  );
  for (const row of stuck.rows) {
    if (!row.extraction_job_id) continue;
    await db.query(
      `UPDATE extraction_jobs SET status = 'failed', completed_at = $2, error_code = 'stuck_reclaimed'
        WHERE id = $1 AND status IN ('pending', 'running')`,
      [row.extraction_job_id, now],
    );
  }
  return stuck.rows.length;
}

/**
 * The Custom Source (`generated_custom`) implementation of the shared locked
 * Channel scan enqueue (`enqueueChannelScanIfDue`, scanSchedule.ts). Inserts a
 * paired `extraction_jobs` row (reusing the existing `connection_scan`
 * job_type — no CHECK-constraint change) and a `source_handler_runs` row in
 * the same transaction, so product `source_runs` and the Advanced handler-run
 * history stay populated for Custom Source scans and neither row exists
 * without the other. Any extraction job already in flight for the Channel,
 * not only a scan, keeps it from queueing.
 */
export async function enqueueDueCustomSourceHandlerRuns(
  db: Queryable,
  batchLimit = 25,
): Promise<number> {
  const now = new Date().toISOString();
  const tasks = await listDueSourceChannelScanTasks(db, now, batchLimit);

  let enqueued = 0;
  for (const task of tasks) {
    const queued = await enqueueChannelScanIfDue<DueChannelScanRow & { active_handler_version_id: string }>(db, task, now, {
      columns: ["sc.active_handler_version_id"],
      conditions: `sc.handler_kind = 'generated_custom'
          AND sc.active_handler_version_id IS NOT NULL
          AND sc.repair_status <> 'disabled'
          AND NOT EXISTS (
            SELECT 1
              FROM extraction_jobs any_job
             WHERE any_job.space_id = ch.space_id
               AND any_job.metadata_json->>'source_channel_id' = ch.id
               AND any_job.status IN ('pending', 'running')
          )`,
      metadata: (row) => ({ created_by: "custom_source_scheduler", source_channel_id: row.channel_id }),
      afterInsert: async (tx, row, jobId) => {
        await tx.query(
          `INSERT INTO source_handler_runs (
             id, space_id, source_connection_id, handler_version_id, extraction_job_id, status, created_at
           ) VALUES ($1, $2, $3, $4, $5, 'queued', $6)`,
          [randomUUID(), row.space_id, row.connection_id, row.active_handler_version_id, jobId, now],
        );
      },
    });
    if (queued) enqueued += 1;
  }
  return enqueued;
}
