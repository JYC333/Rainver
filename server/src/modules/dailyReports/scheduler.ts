import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { wakeJobWorkers } from "../jobs/wakeSignal.js";
import {
  isValidTimezone,
  localDateFromSlot,
  PgDailyReportSettingsRepository,
  type DailyReportSettingRow,
} from "./repository.js";

export async function scanDailyReportsAndEnqueue(config: ServerConfig): Promise<number> {
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
      // The job and the slot advance commit together: a job enqueued with
      // `next_run_at` left behind would be enqueued again by the next scan.
      await withTransaction(db, async (tx) => {
        await new PgJobQueueRepository(tx).enqueue({
          job_type: "daily_capture_report",
          space_id: setting.space_id,
          user_id: setting.user_id,
          priority: 0,
          max_attempts: 1,
          payload,
        });
        await new PgDailyReportSettingsRepository(tx).advanceNextRun(setting, slotUtc);
      });
      wakeJobWorkers();
      count += 1;
    } catch {
      // Nothing was written, so the next scan retries this slot.
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
