import { randomUUID } from "node:crypto";
import type { Queryable } from "../../routeUtils/common.js";
import { listDueSourceChannelScanTasks } from "../sourceConnectionScheduler.js";

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
 * Mirrors `enqueueDueSourceConnectionScans` (scanSchedule.ts) for
 * `generated_custom` connections only. Inserts a paired `extraction_jobs`
 * row (reusing the existing `connection_scan` job_type — no CHECK-constraint
 * change) and a `source_handler_runs` row so product `source_runs` and the
 * Advanced handler-run history stay populated for Custom Source scans.
 */
export async function enqueueDueCustomSourceHandlerRuns(
  db: Queryable,
  batchLimit = 25,
): Promise<number> {
  const now = new Date().toISOString();
  const tasks = await listDueSourceChannelScanTasks(db, now, batchLimit);

  let enqueued = 0;
  for (const task of tasks) {
    if (!task.space_id) continue;
    const due = await db.query<{
      id: string;
      channel_id: string;
      space_id: string;
      active_handler_version_id: string;
    }>(
      `SELECT sc.id, ch.id AS channel_id, sc.space_id, sc.active_handler_version_id
         FROM source_channels ch
         JOIN source_connections sc ON sc.id = ch.source_connection_id
        WHERE ch.status = 'active' AND sc.status = 'active'
          AND sc.deleted_at IS NULL
          AND sc.space_id = $1
          AND ch.id = $2
          AND sc.handler_kind = 'generated_custom'
          AND sc.active_handler_version_id IS NOT NULL
          AND sc.repair_status <> 'disabled'
          AND ch.fetch_frequency <> 'manual'
          AND NOT EXISTS (
            SELECT 1
              FROM extraction_jobs ej
             WHERE ej.space_id = ch.space_id
               AND ej.metadata_json->>'source_channel_id' = ch.id
               AND ej.status IN ('pending', 'running')
          )
        LIMIT 1`,
      [task.space_id, task.task_key],
    );
    const row = due.rows[0];
    if (!row) continue;
    const jobId = randomUUID();
    await db.query(
      `INSERT INTO extraction_jobs (
         id, space_id, connection_id, job_type, status, metadata_json, created_at
       ) VALUES ($1, $2, $3, 'connection_scan', 'pending', $4::jsonb, $5)`,
      [jobId, row.space_id, row.id, JSON.stringify({ created_by: "custom_source_scheduler", source_channel_id: row.channel_id }), now],
    );
    await db.query(
      `INSERT INTO source_handler_runs (
         id, space_id, source_connection_id, handler_version_id, extraction_job_id, status, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'queued', $6)`,
      [randomUUID(), row.space_id, row.id, row.active_handler_version_id, jobId, now],
    );
    enqueued += 1;
  }
  return enqueued;
}
