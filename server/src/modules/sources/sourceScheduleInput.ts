import { HttpError, objectValue, optionalString } from "../routeUtils/common.js";

const SCHEDULED_FETCH_FREQUENCIES = new Set(["hourly", "daily", "weekly"]);

export type SourceScheduleRule =
  | { frequency: "hourly"; minute: number }
  | { frequency: "daily"; hour: number; minute: number }
  | { frequency: "weekly"; weekday: number; hour: number; minute: number };

export interface ResolvedSourceSchedule {
  nextRunAt: string | null;
  scheduleRule: SourceScheduleRule | null;
}

export function isScheduledFetchFrequency(fetchFrequency: string): boolean {
  return SCHEDULED_FETCH_FREQUENCIES.has(fetchFrequency);
}

export function resolveRequestedSourceSchedule(input: {
  body: Record<string, unknown>;
  status: string;
  fetchFrequency: string;
  existingNextCheckAt?: unknown;
  existingScheduleRule?: unknown;
  now?: Date;
}): ResolvedSourceSchedule {
  if (input.fetchFrequency === "manual" || !isScheduledFetchFrequency(input.fetchFrequency)) {
    return { nextRunAt: null, scheduleRule: null };
  }

  const now = input.now ?? new Date();
  const requestedRule = parseRequestedScheduleRule(input.body);
  if (requestedRule !== undefined) {
    if (requestedRule === null) {
      if (input.status === "active") {
        throw new HttpError(422, "schedule_rule is required for scheduled source connections");
      }
      return { nextRunAt: null, scheduleRule: null };
    }
    ensureScheduleFrequency(requestedRule, input.fetchFrequency);
    return {
      nextRunAt: computeNextRunAtFromScheduleRule(requestedRule, now),
      scheduleRule: requestedRule,
    };
  }

  const requestedNextCheckAt = parseRequestedNextCheckAt(input.body);
  if (requestedNextCheckAt !== undefined) {
    if (requestedNextCheckAt === null) {
      if (input.status === "active") {
        throw new HttpError(422, "schedule_rule is required for scheduled source connections");
      }
      return { nextRunAt: null, scheduleRule: null };
    }
    ensureFutureNextCheckAt(requestedNextCheckAt, now);
    return {
      nextRunAt: requestedNextCheckAt,
      scheduleRule: scheduleRuleFromDate(input.fetchFrequency, requestedNextCheckAt),
    };
  }

  const existingRule = parseSourceScheduleRule(input.existingScheduleRule);
  if (existingRule && existingRule.frequency === input.fetchFrequency) {
    const existing = futureTimestampString(input.existingNextCheckAt, now);
    return {
      nextRunAt: existing ?? computeNextRunAtFromScheduleRule(existingRule, now),
      scheduleRule: existingRule,
    };
  }

  const existing = futureTimestampString(input.existingNextCheckAt, now);
  if (existing) {
    return {
      nextRunAt: existing,
      scheduleRule: scheduleRuleFromDate(input.fetchFrequency, existing),
    };
  }

  if (input.status !== "active") return { nextRunAt: null, scheduleRule: null };
  throw new HttpError(422, "schedule_rule is required for scheduled source connections");
}

export function parseRequestedScheduleRule(body: Record<string, unknown>): SourceScheduleRule | null | undefined {
  if (!Object.hasOwn(body, "schedule_rule")) return undefined;
  if (body.schedule_rule === undefined) return undefined;
  if (body.schedule_rule === null) return null;
  return requiredScheduleRule(body.schedule_rule);
}

export function parseSourceScheduleRule(value: unknown): SourceScheduleRule | null {
  if (!value || typeof value !== "object") return null;
  try {
    return requiredScheduleRule(value);
  } catch {
    return null;
  }
}

export function computeNextRunAtFromScheduleRule(rule: SourceScheduleRule, from: Date | string = new Date()): string {
  const base = dateValue(from) ?? new Date();
  const candidate = new Date(base);
  candidate.setUTCSeconds(0, 0);
  if (rule.frequency === "hourly") {
    candidate.setUTCMinutes(rule.minute, 0, 0);
    if (candidate.getTime() <= base.getTime()) candidate.setUTCHours(candidate.getUTCHours() + 1);
    return candidate.toISOString();
  }
  if (rule.frequency === "daily") {
    candidate.setUTCHours(rule.hour, rule.minute, 0, 0);
    if (candidate.getTime() <= base.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate.toISOString();
  }

  const currentWeekday = isoUtcWeekday(candidate);
  let daysToAdd = rule.weekday - currentWeekday;
  if (daysToAdd < 0) daysToAdd += 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysToAdd);
  candidate.setUTCHours(rule.hour, rule.minute, 0, 0);
  if (candidate.getTime() <= base.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 7);
  return candidate.toISOString();
}

export function scheduleRuleFromDate(fetchFrequency: string, dateInput: Date | string): SourceScheduleRule {
  const date = dateValue(dateInput);
  if (!date) throw new HttpError(422, "next_check_at must be a valid datetime");
  const minute = date.getUTCMinutes();
  if (fetchFrequency === "hourly") return { frequency: "hourly", minute };
  const hour = date.getUTCHours();
  if (fetchFrequency === "daily") return { frequency: "daily", hour, minute };
  if (fetchFrequency === "weekly") return { frequency: "weekly", weekday: isoUtcWeekday(date), hour, minute };
  throw new HttpError(422, "schedule_rule is only supported for hourly, daily, or weekly source connections");
}

export function parseRequestedNextCheckAt(body: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(body, "next_check_at")) return undefined;
  if (body.next_check_at === undefined) return undefined;
  if (body.next_check_at === null) return null;
  const raw = optionalString(body.next_check_at);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(422, "next_check_at must be a valid datetime");
  return parsed.toISOString();
}

function requiredScheduleRule(value: unknown): SourceScheduleRule {
  const raw = objectValue(value);
  const frequency = optionalString(raw.frequency);
  if (frequency === "hourly") {
    return { frequency, minute: boundedInteger(raw.minute, "schedule_rule.minute", 0, 59) };
  }
  if (frequency === "daily") {
    return {
      frequency,
      hour: boundedInteger(raw.hour, "schedule_rule.hour", 0, 23),
      minute: boundedInteger(raw.minute, "schedule_rule.minute", 0, 59),
    };
  }
  if (frequency === "weekly") {
    return {
      frequency,
      weekday: boundedInteger(raw.weekday, "schedule_rule.weekday", 1, 7),
      hour: boundedInteger(raw.hour, "schedule_rule.hour", 0, 23),
      minute: boundedInteger(raw.minute, "schedule_rule.minute", 0, 59),
    };
  }
  throw new HttpError(422, "schedule_rule.frequency must be hourly, daily, or weekly");
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(422, `${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function ensureScheduleFrequency(rule: SourceScheduleRule, fetchFrequency: string): void {
  if (rule.frequency !== fetchFrequency) {
    throw new HttpError(422, "schedule_rule.frequency must match fetch_frequency");
  }
}

function ensureFutureNextCheckAt(value: string, now: Date): void {
  const parsed = new Date(value);
  if (parsed.getTime() <= now.getTime()) {
    throw new HttpError(422, "next_check_at must be in the future for scheduled source connections");
  }
}

function futureTimestampString(value: unknown, now: Date): string | null {
  const date = dateValue(value);
  if (!date || date.getTime() <= now.getTime()) return null;
  return date.toISOString();
}

function dateValue(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoUtcWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}
