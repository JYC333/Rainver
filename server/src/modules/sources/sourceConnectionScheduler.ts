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

export async function listDueSourceChannelScanTasks(
  db: Queryable,
  nowIso: string,
  limit: number,
): Promise<SchedulerTaskRow[]> {
  return new PgSchedulerTaskStore(db).listDue(SOURCE_CHANNEL_SCAN_TASK_TYPE, nowIso, limit);
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
