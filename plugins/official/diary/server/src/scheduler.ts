import type { Queryable, PluginScheduledTask } from "@rainver/protocol";
import { diaryRepository } from "./domain/repository.js";

interface SchedulerLogger {
  info(message: string): void;
  warn(message: string): void;
}

export function buildDiaryDailyPromptTask(
  db: Queryable,
  pluginId: string,
  log?: SchedulerLogger,
): PluginScheduledTask {
  return {
    name: "diary_daily_prompt",
    intervalSeconds: 6 * 3600,
    runOnStart: false,
    run: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const enabledUsers = await diaryRepository.findEnabledUserIds(db, pluginId);

      let reminded = 0;
      for (const userId of enabledUsers) {
        const existing = await diaryRepository.findEntry(db, userId, today);
        if (!existing) {
          log?.info(`[diary] user ${userId} has not written today (${today})`);
          reminded++;
        }
      }

      if (reminded > 0) {
        log?.info(
          `[diary] daily_prompt: ${reminded}/${enabledUsers.length} users reminded`,
        );
      }
    },
  };
}
