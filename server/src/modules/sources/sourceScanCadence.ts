import { computeNextRunAtFromScheduleRule, parseSourceScheduleRule } from "./sourceScheduleInput.js";

const INTERVAL_MS: Record<string, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Pure cadence calculation shared by activation and post-scan rescheduling. */
export function computeNextCheckAt(
  fetchFrequency: string,
  completedAt: Date | string = new Date(),
  options: { manualRun?: boolean; existingNextCheckAt?: unknown; scheduleRule?: unknown } = {},
): string | null {
  if (fetchFrequency === "manual") return null;
  const interval = INTERVAL_MS[fetchFrequency];
  if (!interval) return null;
  const completed = typeof completedAt === "string" ? new Date(completedAt) : completedAt;
  const completedMs = Number.isNaN(completed.getTime()) ? Date.now() : completed.getTime();
  const existing = dateValue(options.existingNextCheckAt);
  if (options.manualRun && existing && existing.getTime() > completedMs) {
    return existing.toISOString();
  }
  const scheduleRule = parseSourceScheduleRule(options.scheduleRule);
  if (scheduleRule?.frequency === fetchFrequency) {
    return computeNextRunAtFromScheduleRule(scheduleRule, new Date(completedMs));
  }
  return new Date(completedMs + interval).toISOString();
}

function dateValue(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
