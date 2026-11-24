/**
 * Calendar days in a configured IANA timezone, for work that is scheduled by
 * a slot and reports on a whole day.
 *
 * A daily report or digest covers one *complete* local day: the half-open
 * UTC interval `[start, end)` of that day in the configured timezone. The day
 * a scheduled fire covers is derived from the fire's slot, never from the
 * worker's wall clock — a slot that runs late still names the day it was
 * scheduled for — and the previous local day of the slot is the last complete
 * one. DST transitions make a local day 23 or 25 hours long; the bounds come
 * from the zone's own clock, so no item falls between two days or into both.
 *
 * `Intl.DateTimeFormat` is the only timezone engine here; nothing re-derives
 * offsets by hand.
 */

export interface LocalDayBounds {
  startUtcIso: string;
  endUtcIso: string;
}

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_PROBE_WINDOW_MS = 24 * 3_600_000;

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The local calendar date (`YYYY-MM-DD`) a UTC instant falls on in `timezone`. */
export function localDateFromSlot(slotUtcIso: string, timezone: string): string {
  const parts = zonedParts(new Date(slotUtcIso), timezone || "UTC");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** The local calendar date `now` falls on in `timezone`. */
export function localDateNow(timezone: string, now: Date = new Date()): string {
  return localDateFromSlot(now.toISOString(), timezone);
}

/** The calendar day before `localDate` — the last complete day as seen from a slot on `localDate`. */
export function previousLocalDate(localDate: string, days = 1): string {
  const parts = parseLocalDate(localDate);
  const moved = addLocalDays({ ...parts, hour: 0, minute: 0 }, -days);
  return `${moved.year}-${pad(moved.month)}-${pad(moved.day)}`;
}

/** The complete day a scheduled slot reports on: the local day before the slot's own. */
export function reportDateForSlot(slotUtcIso: string, timezone: string): string {
  return previousLocalDate(localDateFromSlot(slotUtcIso, timezone));
}

/** Half-open UTC bounds `[start, end)` of one local calendar day. */
export function localDayUtcBounds(localDate: string, timezone: string): LocalDayBounds {
  const zone = timezone || "UTC";
  const startLocal = { ...parseLocalDate(localDate), hour: 0, minute: 0 };
  const endLocal = addLocalDays(startLocal, 1);
  return {
    startUtcIso: firstInstantOfLocalDay(startLocal, zone).toISOString(),
    endUtcIso: firstInstantOfLocalDay(endLocal, zone).toISOString(),
  };
}

/**
 * The first instant whose local date is `day`: local midnight, or where the
 * clock jumps forward at midnight (America/Santiago, America/Havana) the end
 * of that gap, which `zonedLocalToUtc` resolves to.
 */
function firstInstantOfLocalDay(day: LocalDateTimeParts, timeZone: string): Date {
  return zonedLocalToUtc(day, timeZone);
}

/** Whether every instant of the local day has passed, so a report on it covers all of it. */
export function isLocalDayComplete(localDate: string, timezone: string, now: Date = new Date()): boolean {
  return Date.parse(localDayUtcBounds(localDate, timezone).endUtcIso) <= now.getTime();
}

/**
 * The UTC instant of a local wall-clock time, by the zone's own clock.
 *
 * A wall time the clock skips (a DST gap) is read with the offset in force
 * before the jump, which lands the same distance past it: 02:30 on New York's
 * spring-forward day is 03:30 EDT, and Santiago's skipped midnight is 01:00,
 * on its own day. A wall time that happens twice (fall back) is its first
 * occurrence. A scheduled slot therefore never lands before its wall time, and
 * never on the previous local day. `cron-parser` resolves both the same way.
 */
export function zonedLocalToUtc(parts: LocalDateTimeParts, timeZone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  // target encodes the wall time as UTC. Probe a full day on each side
  // to bracket transitions even in zones with offsets beyond ±12 hours.
  const before = zoneOffsetAt(target - OFFSET_PROBE_WINDOW_MS, timeZone);
  const after = zoneOffsetAt(target + OFFSET_PROBE_WINDOW_MS, timeZone);
  const valid = [target - before, target - after]
    .filter((instant) => zoneOffsetAt(instant, timeZone) === target - instant)
    .sort((a, b) => a - b);
  return new Date(valid[0] ?? target - before);
}

/** The zone's offset from UTC at an instant, in milliseconds (minute precision). */
function zoneOffsetAt(instant: number, timeZone: string): number {
  const local = zonedParts(new Date(instant), timeZone);
  const minute = Math.floor(instant / 60_000) * 60_000;
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0) - minute;
}

export function zonedParts(date: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

export function addLocalDays(parts: LocalDateTimeParts, days: number): LocalDateTimeParts {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function parseLocalDate(localDate: string): { year: number; month: number; day: number } {
  const match = LOCAL_DATE.exec(localDate);
  if (!match) throw new Error(`Invalid local_date ${JSON.stringify(localDate)}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
