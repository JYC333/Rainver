import { randomUUID } from "node:crypto";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import type { SchedulerTaskRow } from "../scheduler/taskStore.js";
import {
  CHANNEL_SCAN_RUNNABLE_SQL,
  SOURCE_CHANNEL_SCAN_TASK_TYPE,
  listDueSourceChannelScanTasks,
} from "./sourceConnectionScheduler.js";

/** The Channel and connection a locked re-check admitted for one scan. */
export interface DueChannelScanRow {
  channel_id: string;
  space_id: string;
  connection_id: string;
  [column: string]: unknown;
}

/** How one scan implementation (built-in, Custom Source, recipe) queues its scan. */
export interface ChannelScanEnqueueSpec<Row extends DueChannelScanRow> {
  /** Extra `sc.` columns the job needs, e.g. `sc.active_recipe_version_id`. */
  columns?: readonly string[];
  /** This implementation's own conditions over `ch`/`sc`; constant SQL only. */
  conditions: string;
  metadata(row: Row): Record<string, unknown>;
  /** Writes paired with the job, inside the same transaction. */
  afterInsert?(tx: Queryable, row: Row, jobId: string): Promise<void>;
}

/**
 * Enqueues one due Channel's scan, or nothing. Every scheduler that turns a
 * due `source_channel_scan` task into an `extraction_jobs` row goes through
 * here: the connection is locked FOR SHARE and then the Channel FOR UPDATE —
 * the parent-before-Channel order Channel edits, monitor-parent locks and
 * Goal reconfirmation take — and only then, in a fresh statement, is the
 * task re-checked as still due and runnable (shared with the due-batch read),
 * with the implementation's own conditions. The insert and any paired rows
 * commit in that transaction. Overlapping ticks or schedulers therefore queue
 * at most one pending scan per Channel and never one for a Channel that a
 * concurrent pause, deletion, reschedule or Goal binding committed first.
 */
export async function enqueueChannelScanIfDue<Row extends DueChannelScanRow>(
  db: Queryable,
  task: Pick<SchedulerTaskRow, "space_id" | "task_key">,
  now: string,
  spec: ChannelScanEnqueueSpec<Row>,
): Promise<boolean> {
  const spaceId = task.space_id;
  if (!spaceId) return false;
  return withQueryableTransaction(db, async (tx) => {
    const parent = await tx.query<{ source_connection_id: string }>(
      `SELECT source_connection_id FROM source_channels WHERE space_id = $1 AND id = $2`,
      [spaceId, task.task_key],
    );
    const connectionId = parent.rows[0]?.source_connection_id;
    if (!connectionId) return false;
    await tx.query(
      `SELECT id FROM source_connections WHERE space_id = $1 AND id = $2 FOR SHARE`,
      [spaceId, connectionId],
    );
    const locked = await tx.query(
      `SELECT id FROM source_channels WHERE space_id = $1 AND id = $2 AND source_connection_id = $3 FOR UPDATE`,
      [spaceId, task.task_key, connectionId],
    );
    if (!locked.rows[0]) return false;
    const extra = (spec.columns ?? []).map((column) => `, ${column}`).join("");
    const due = await tx.query<Row>(
      `SELECT ch.id AS channel_id, ch.space_id, sc.id AS connection_id${extra}
         FROM source_channels ch
         JOIN source_connections sc ON sc.id = ch.source_connection_id AND sc.space_id = ch.space_id
         JOIN scheduler_tasks st ON st.task_type = $3 AND st.task_key = ch.id AND st.space_id = ch.space_id
        WHERE ch.space_id = $1
          AND ch.id = $2
          AND st.next_run_at IS NOT NULL
          AND st.next_run_at <= $4
          AND ${CHANNEL_SCAN_RUNNABLE_SQL}
          AND ${spec.conditions}
        LIMIT 1`,
      [spaceId, task.task_key, SOURCE_CHANNEL_SCAN_TASK_TYPE, now],
    );
    const row = due.rows[0];
    if (!row) return false;
    const jobId = randomUUID();
    await tx.query(
      `INSERT INTO extraction_jobs (
         id, space_id, connection_id, job_type, status, metadata_json, created_at
       ) VALUES ($1, $2, $3, 'connection_scan', 'pending', $4::jsonb, $5)`,
      [jobId, row.space_id, row.connection_id, JSON.stringify(spec.metadata(row)), now],
    );
    await spec.afterInsert?.(tx, row, jobId);
    return true;
  });
}

/**
 * Every scheduled scan is owned by a Channel. A Connection is only the
 * policy/credential boundary and may therefore back multiple independent
 * schedules. This is the built-in implementation's pass.
 */
export async function enqueueDueSourceChannelScans(
  db: Queryable,
  batchLimit = 25,
): Promise<number> {
  const now = new Date().toISOString();
  const tasks = await listDueSourceChannelScanTasks(db, now, batchLimit);
  let enqueued = 0;
  for (const task of tasks) {
    const queued = await enqueueChannelScanIfDue(db, task, now, {
      conditions: `sc.handler_kind = 'built_in'`,
      metadata: (row) => ({ created_by: "scheduler", source_channel_id: row.channel_id }),
    });
    if (queued) enqueued += 1;
  }
  return enqueued;
}
