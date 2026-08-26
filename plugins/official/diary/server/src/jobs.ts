import type { Queryable, PluginJobHandler } from "@rainver/protocol";
import { diaryRepository } from "./domain/repository.js";

export const JOB_TYPE_DIARY_REFLECTION = "diary_reflection";

export interface DiaryReflectionJobPayload {
  user_id: string;
  entry_id: string;
  entry_date: string;
}

export function buildDiaryReflectionHandler(db: Queryable, pluginId: string): PluginJobHandler {
  return async (job) => {
    const { user_id, entry_id, entry_date } = job.payload as unknown as DiaryReflectionJobPayload;

    if (!(await diaryRepository.isAiReflectionEnabled(db, pluginId, user_id))) {
      return { skipped: true, reason: "reflection_disabled" };
    }

    const pastEntries = await diaryRepository.findOnThisDay(db, user_id, entry_date);
    const relevant = pastEntries.filter((e) => e.id !== entry_id);

    if (relevant.length === 0) {
      return { skipped: true, reason: "no_past_entries" };
    }

    const lines = [
      `On this day across ${relevant.length} previous year(s):`,
      "",
      ...relevant.map(
        (e) =>
          `**${e.entry_date}**: ${e.content.slice(0, 200)}${e.content.length > 200 ? "..." : ""}`,
      ),
    ];

    await diaryRepository.insertReflection(
      db,
      entry_id,
      new Date().toISOString().slice(0, 10),
      lines.join("\n"),
      "stub",
    );

    return { entry_id, past_entries_count: relevant.length };
  };
}
