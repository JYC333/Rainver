import {
  PgSchedulerTaskStore,
  type SchedulerTaskRow,
  type SchedulerTaskStatus,
} from "../scheduler/taskStore.js";
import type { Queryable } from "../routeUtils/common.js";
import { computeNextCheckAt } from "./sourceScanCadence.js";

export const SOURCE_CHANNEL_SCAN_TASK_TYPE = "source_channel_scan";

export interface SourceChannelScheduleTarget {
  id: string;
  space_id: string;
  owner_user_id: string;
  status: string;
  fetch_frequency: string;
}

export function sourceChannelSchedulerTaskKey(channelId: string): string {
  return channelId;
}

export async function getSourceChannelScanTask(
  db: Queryable,
  channelId: string,
): Promise<SchedulerTaskRow | null> {
  return new PgSchedulerTaskStore(db).get(SOURCE_CHANNEL_SCAN_TASK_TYPE, sourceChannelSchedulerTaskKey(channelId));
}

/**
 * Due scan tasks that a scan scheduler could act on now. The built-in, recipe
 * and Custom Source schedulers share this batch and each skips what is not its
 * own, so a task none of them can run — its channel or connection inactive,
 * deleted or manual, or a scan already in flight — is left out here. Kept in
 * the batch, it would stay due without ever being advanced, and enough of them
 * would fill every tick's batch.
 */
export async function listDueSourceChannelScanTasks(
  db: Queryable,
  nowIso: string,
  limit: number,
): Promise<SchedulerTaskRow[]> {
  const result = await db.query<SchedulerTaskRow>(
    `SELECT st.id, st.task_type, st.task_key, st.scope_type, st.scope_id, st.space_id, st.user_id, st.status,
            st.next_run_at, st.last_run_at, st.state_json, st.metadata_json, st.created_at, st.updated_at
       FROM scheduler_tasks st
       JOIN source_channels ch ON ch.id = st.task_key AND ch.space_id = st.space_id
       JOIN source_connections sc ON sc.id = ch.source_connection_id AND sc.space_id = ch.space_id
      WHERE st.task_type = $1
        AND st.status = 'active'
        AND st.next_run_at IS NOT NULL
        AND st.next_run_at <= $2
        AND ch.status = 'active'
        AND ch.fetch_frequency <> 'manual'
        AND sc.status = 'active'
        AND sc.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM extraction_jobs ej
           WHERE ej.space_id = ch.space_id
             AND ej.job_type = 'connection_scan'
             AND ej.metadata_json->>'source_channel_id' = ch.id
             AND ej.status IN ('pending', 'running')
        )
      ORDER BY st.next_run_at ASC
      LIMIT $3`,
    [SOURCE_CHANNEL_SCAN_TASK_TYPE, nowIso, limit],
  );
  return result.rows.map((row) => ({
    ...row,
    state_json: objectOrEmpty(row.state_json),
    metadata_json: objectOrEmpty(row.metadata_json),
  }));
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function upsertSourceChannelScanTask(
  db: Queryable,
  input: {
    channel: SourceChannelScheduleTarget;
    nextRunAt: string | null;
    lastRunAt?: string | null;
    cursor?: Record<string, unknown>;
    watermark?: Record<string, unknown>;
    updatedAt?: string;
  },
): Promise<SchedulerTaskRow> {
  const taskStore = new PgSchedulerTaskStore(db);
  const existing = await taskStore.get(SOURCE_CHANNEL_SCAN_TASK_TYPE, sourceChannelSchedulerTaskKey(input.channel.id));
  const status = sourceChannelSchedulerStatus(input.channel.status);
  const metadata = { ...(existing?.metadata_json ?? {}) };
  if (input.cursor !== undefined) metadata.cursor = input.cursor;
  if (input.watermark !== undefined) metadata.watermark = input.watermark;
  return taskStore.upsert({
    taskType: SOURCE_CHANNEL_SCAN_TASK_TYPE,
    taskKey: sourceChannelSchedulerTaskKey(input.channel.id),
    scopeType: "space",
    scopeId: input.channel.space_id,
    spaceId: input.channel.space_id,
    userId: input.channel.owner_user_id,
    status,
    nextRunAt: status === "archived" ? null : input.nextRunAt,
    lastRunAt: input.lastRunAt ?? null,
    stateJson: existing?.state_json ?? {},
    metadataJson: metadata,
    updatedAt: input.updatedAt,
  });
}

/**
 * Reschedules a channel's scan task when a scan ends, from the channel as it
 * is now rather than as it was when the scan started, so a pause, archive, or
 * change of frequency or rule made while the scan ran is kept.
 */
export async function rescheduleSourceChannelScanAfterRun(
  db: Queryable,
  input: { channelId: string; completedAt: string },
): Promise<void> {
  const result = await db.query<SourceChannelScheduleTarget & { schedule_rule_json: unknown }>(
    `SELECT ch.id, ch.space_id, sc.owner_user_id, ch.status, ch.fetch_frequency, ch.schedule_rule_json
       FROM source_channels ch
       JOIN source_connections sc ON sc.id = ch.source_connection_id AND sc.space_id = ch.space_id
      WHERE ch.id = $1`,
    [input.channelId],
  );
  const channel = result.rows[0];
  if (!channel) return;
  const task = await getSourceChannelScanTask(db, channel.id);
  await upsertSourceChannelScanTask(db, {
    channel,
    nextRunAt: channel.status === "active"
      ? computeNextCheckAt(channel.fetch_frequency, input.completedAt, {
        existingNextCheckAt: task?.next_run_at,
        scheduleRule: channel.schedule_rule_json,
      })
      : null,
    lastRunAt: input.completedAt,
    updatedAt: input.completedAt,
  });
}

function sourceChannelSchedulerStatus(status: string): SchedulerTaskStatus {
  if (status === "archived") return "archived";
  if (status === "active") return "active";
  return "paused";
}
