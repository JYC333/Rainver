import {
  PgSchedulerTaskStore,
  type SchedulerTaskRow,
  type SchedulerTaskStatus,
} from "../scheduler/taskStore.js";
import type { Queryable } from "../routeUtils/common.js";

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

function sourceChannelSchedulerStatus(status: string): SchedulerTaskStatus {
  if (status === "archived") return "archived";
  if (status === "active") return "active";
  return "paused";
}
