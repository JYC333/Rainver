/**
 * Pure timing rules of Gmail digests (ADR 0033 phase B). The daily slot uses
 * the Automations cron evaluator (`automations/schedule.ts`) with the owner's
 * IANA time zone, so daylight-saving changes follow the owner's clock.
 */
import { GMAIL_DIGEST_LIMITS } from "@rainver/protocol";
import { computeNextRunAt, computePreviousRunAt } from "../../automations/schedule.js";

/** Whether the runtime knows this IANA time zone. */
export function validGmailDigestTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}

/** The first `HH:MM` in `timeZone` strictly after `after`. */
export function nextGmailDigestSlot(localTime: string, timeZone: string, after: Date): Date {
  return computeNextRunAt(dailySchedule(localTime, timeZone), after);
}

function dailySchedule(localTime: string, timeZone: string) {
  const [hour, minute] = localTime.split(":").map(Number);
  return { cron: `${minute} ${hour} * * *`, timezone: timeZone };
}

/**
 * Read through the due slot, so heartbeat jitter cannot shorten the next
 * window. After a missed slot, catch up to now with a bounded reported gap.
 */
export function gmailDigestDailyWindow(
  coveredUntil: Date, now: Date, slot: Date, localTime: string, timeZone: string,
): { start: Date; end: Date; gapBefore: boolean } {
  const schedule = dailySchedule(localTime, timeZone);
  const previousSlot = computePreviousRunAt(schedule, slot);
  const end = now < computeNextRunAt(schedule, slot) ? slot : now;
  const windowMs = Math.max(GMAIL_DIGEST_LIMITS.windowHours * 3_600_000, slot.getTime() - previousSlot.getTime());
  const earliest = new Date(end.getTime() - windowMs);
  const start = coveredUntil > earliest ? coveredUntil : earliest;
  return { start: start > end ? end : start, end, gapBefore: coveredUntil < earliest };
}

/** Retry floor after the `failures`-th consecutive failure: 15 min doubling, at most 6 h. */
export function gmailDigestRetryDelayMs(failures: number): number {
  return Math.min(6 * 3_600_000, 15 * 60_000 * 2 ** Math.max(0, Math.min(failures, 10) - 1));
}
