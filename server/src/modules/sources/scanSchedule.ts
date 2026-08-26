import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import { listDueSourceChannelScanTasks } from "./sourceConnectionScheduler.js";

/**
 * Every scheduled scan is owned by a Channel. A Connection is only the
 * policy/credential boundary and may therefore back multiple independent
 * schedules.
 */
export async function enqueueDueSourceChannelScans(
  db: Queryable,
  batchLimit = 25,
): Promise<number> {
  const now = new Date().toISOString();
  const tasks = await listDueSourceChannelScanTasks(db, now, batchLimit);
  let enqueued = 0;
  for (const task of tasks) {
    if (!task.space_id) continue;
    const due = await db.query<{ id: string; space_id: string; source_connection_id: string }>(
      `SELECT ch.id, ch.space_id, ch.source_connection_id
         FROM source_channels ch
         JOIN source_connections sc ON sc.id = ch.source_connection_id
        WHERE ch.status = 'active'
          AND sc.status = 'active'
          AND sc.deleted_at IS NULL
          AND ch.space_id = $1
          AND ch.id = $2
          AND ch.fetch_frequency <> 'manual'
          AND sc.handler_kind = 'built_in'
          AND NOT EXISTS (
            SELECT 1
              FROM extraction_jobs ej
             WHERE ej.space_id = ch.space_id
               AND ej.connection_id = ch.source_connection_id
               AND ej.job_type = 'connection_scan'
               AND ej.metadata_json->>'source_channel_id' = ch.id
               AND ej.status IN ('pending', 'running')
          )
        LIMIT 1`,
      [task.space_id, task.task_key],
    );
    const row = due.rows[0];
    if (!row) continue;
    await db.query(
      `INSERT INTO extraction_jobs (
         id, space_id, connection_id, job_type, status, metadata_json, created_at
       ) VALUES ($1, $2, $3, 'connection_scan', 'pending', $4::jsonb, $5)`,
      [
        randomUUID(),
        row.space_id,
        row.source_connection_id,
        JSON.stringify({ created_by: "scheduler", source_channel_id: row.id }),
        now,
      ],
    );
    enqueued += 1;
  }
  return enqueued;
}
