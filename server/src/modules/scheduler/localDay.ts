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
  const startLocal = { ...parseLocalDate(localDate), hour: 0, minute: 0 };
  const endLocal = addLocalDays(startLocal, 1);
  return {
    startUtcIso: zonedLocalToUtc(startLocal, timezone || "UTC").toISOString(),
    endUtcIso: zonedLocalToUtc(endLocal, timezone || "UTC").toISOString(),
  };
}

/** Whether every instant of the local day has passed, so a report on it covers all of it. */
export function isLocalDayComplete(localDate: string, timezone: string, now: Date = new Date()): boolean {
  return Date.parse(localDayUtcBounds(localDate, timezone).endUtcIso) <= now.getTime();
}

/** The UTC instant of a local wall-clock time, by the zone's own clock. */
export function zonedLocalToUtc(parts: LocalDateTimeParts, timeZone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
      0,
    );
    const delta = actualAsUtc - target;
    if (delta === 0) break;
    guess -= delta;
  }
  return new Date(guess);
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
