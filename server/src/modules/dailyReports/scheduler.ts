import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { PgJobQueueRepository } from "../jobs/repository.js";
import {
  isValidTimezone,
  localDateFromSlot,
  PgDailyReportSettingsRepository,
  type DailyReportSettingRow,
} from "./repository.js";

export async function scanDailyReportsAndEnqueue(
  config: ServerConfig,
  queue: PgJobQueueRepository,
): Promise<number> {
  if (!config.databaseUrl) return 0;
  const db = getDbPool(config.databaseUrl);
  const repo = new PgDailyReportSettingsRepository(db);
  const nowIso = new Date().toISOString();
  const due = await repo.listDue(nowIso);
  let count = 0;
  for (const setting of due) {
    const slotUtc = setting.next_run_at ?? nowIso;
    const payload = buildDailyReportJobPayload(setting, slotUtc);
    if (!payload) continue;
    try {
      await queue.enqueue({
        job_type: "daily_capture_report",
        space_id: setting.space_id,
        user_id: setting.user_id,
        priority: 0,
        max_attempts: 1,
        payload,
      });
      await repo.advanceNextRun(setting, slotUtc);
      count += 1;
    } catch {
      // Leave next_run_at unchanged so the next scan retries.
    }
  }
  return count;
}

export function buildDailyReportJobPayload(
  setting: DailyReportSettingRow,
  slotUtc: string,
): Record<string, unknown> | null {
  if (!isValidTimezone(setting.timezone || "UTC")) return null;
  return {
    space_id: setting.space_id,
    user_id: setting.user_id,
    setting_id: setting.id,
    local_date: localDateFromSlot(slotUtc, setting.timezone),
    timezone: setting.timezone,
    trigger_origin: "automation",
    force: false,
  };
}
