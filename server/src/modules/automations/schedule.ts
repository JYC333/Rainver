import { CronExpressionParser } from "cron-parser";

export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
  }
}

export function parseSchedule(configJson: Record<string, unknown> | null): {
  cron: string;
  timezone: string;
} {
  const cfg = configJson ?? {};
  const cron = cfg.cron;
  if (typeof cron !== "string" || !cron.trim()) {
    throw new InvalidScheduleError("schedule automation requires config_json.cron");
  }
  const timezone = typeof cfg.timezone === "string" && cfg.timezone.trim() ? cfg.timezone : "UTC";
  return { cron, timezone };
}

function scheduleInterval(
  configJson: Record<string, unknown> | null,
  at: Date,
  direction: "next" | "prev",
): Date {
  const { cron, timezone } = parseSchedule(configJson);
  try {
    // tz must always be passed explicitly — cron-parser falls back to the
    // host process's local timezone (not UTC) when it is omitted.
    return CronExpressionParser.parse(cron, { currentDate: at, tz: timezone })[direction]().toDate();
  } catch (error) {
    throw new InvalidScheduleError(error instanceof Error ? error.message : String(error));
  }
}

export function computeNextRunAt(configJson: Record<string, unknown> | null, after = new Date()): Date {
  return scheduleInterval(configJson, after, "next");
}

export function computePreviousRunAt(configJson: Record<string, unknown> | null, before: Date): Date {
  return scheduleInterval(configJson, before, "prev");
}
