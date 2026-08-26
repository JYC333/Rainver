import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry.js";
import { DailyCaptureReportService } from "./service.js";
import { PgDailyReportSettingsRepository } from "./repository.js";

export function registerDailyCaptureReportHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  registry.register("daily_capture_report", async (job) => {
    const spaceId = stringValue(job.payload.space_id) ?? job.space_id;
    const userId = stringValue(job.payload.user_id) ?? job.user_id;
    const localDate = stringValue(job.payload.local_date);
    const settingId = stringValue(job.payload.setting_id);
    if (!spaceId) throw new Error("daily_capture_report handler: missing space_id");
    if (!userId) throw new Error("daily_capture_report handler: missing user_id");
    if (!localDate) throw new Error("daily_capture_report handler: missing local_date");

    const db = getDbPool(config.databaseUrl!);
    const settingsRepo = new PgDailyReportSettingsRepository(db);
    const setting =
      (settingId ? await settingsRepo.getById(spaceId, settingId) : null) ??
      (await settingsRepo.getOrCreate(spaceId, userId));
    if (setting.user_id !== userId) {
      throw new Error("daily_capture_report handler: setting_id does not match user_id");
    }
    const service = new DailyCaptureReportService(db, config);
    const result = await service.generateForDate({
      spaceId,
      userId,
      setting,
      localDate,
      triggerOrigin: stringValue(job.payload.trigger_origin) ?? "automation",
      force: Boolean(job.payload.force),
    });
    return {
      run_id: result.run_id,
      artifact_id: result.artifact_id,
      proposal_ids: result.proposal_ids,
      experience_proposal_ids: result.experience_proposal_ids,
      memory_proposal_ids: result.memory_proposal_ids,
      capture_count: result.capture_count,
      status: result.status,
    };
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
