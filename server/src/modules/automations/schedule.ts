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

export function computeNextRunAt(
  configJson: Record<string, unknown> | null,
  after: Date = new Date(),
): Date {
  const { cron, timezone } = parseSchedule(configJson);
  try {
    // tz must always be passed explicitly — cron-parser falls back to the
    // host process's local timezone (not UTC) when it is omitted.
    const interval = CronExpressionParser.parse(cron, { currentDate: after, tz: timezone });
    return interval.next().toDate();
  } catch (error) {
    throw new InvalidScheduleError(error instanceof Error ? error.message : String(error));
  }
}
