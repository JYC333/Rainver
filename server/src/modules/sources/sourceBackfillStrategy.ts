import { HttpError, objectValue, optionalString } from "../routeUtils/common.js";

const WINDOW_UNITS = ["date_window", "page_cursor", "id_cursor"] as const;
const QUOTA_WINDOWS = ["minute", "hour", "day"] as const;
export const ARXIV_HISTORY_FLOOR = "1991-01-01T00:00:00.000Z";

export const BACKFILL_HISTORY_MODES = ["bounded_range", "all_available"] as const;
export type BackfillHistoryMode = (typeof BACKFILL_HISTORY_MODES)[number];

export interface BackfillStrategy {
  window_unit: (typeof WINDOW_UNITS)[number];
  history_mode: BackfillHistoryMode;
  from: string | null;
  to: string | null;
  window_size: number;
  max_items: number;
  direction: "backward";
  monitoring_field?: "submittedDate" | "lastUpdatedDate";
}

export interface BackfillQuotaPolicy {
  window: (typeof QUOTA_WINDOWS)[number];
  limit_count: number;
}

export interface BackfillSegmentWindow {
  from?: string;
  to?: string;
  cursor?: number;
  max_items: number;
  monitoring_field?: "submittedDate" | "lastUpdatedDate";
}

export function normalizeStrategy(body: Record<string, unknown>): BackfillStrategy {
  const raw = objectValue(body.strategy);
  const windowUnit = optionalString(raw.window_unit) ?? "date_window";
  if (!WINDOW_UNITS.includes(windowUnit as BackfillStrategy["window_unit"])) {
    throw new HttpError(422, "invalid window_unit");
  }
  const direction = optionalString(raw.direction) ?? "backward";
  if (direction !== "backward") {
    throw new HttpError(422, "Only backward history import is currently supported");
  }
  const historyMode = optionalString(raw.history_mode) ?? "bounded_range";
  if (!BACKFILL_HISTORY_MODES.includes(historyMode as BackfillHistoryMode)) {
    throw new HttpError(422, "strategy.history_mode must be bounded_range or all_available");
  }
  const monitoringField = optionalString(raw.monitoring_field) ?? "submittedDate";
  if (!["submittedDate", "lastUpdatedDate"].includes(monitoringField)) {
    throw new HttpError(422, "strategy.monitoring_field must be submittedDate or lastUpdatedDate");
  }
  return {
    window_unit: windowUnit as BackfillStrategy["window_unit"],
    history_mode: historyMode as BackfillHistoryMode,
    from: optionalString(raw.from),
    to: optionalString(raw.to),
    window_size: boundedInteger(raw.window_size, 30, 1, 365, "strategy.window_size"),
    max_items: boundedInteger(raw.max_items, 100, 1, 10000, "strategy.max_items"),
    direction,
    monitoring_field: monitoringField as "submittedDate" | "lastUpdatedDate",
  };
}

export function normalizeQuota(value: unknown): BackfillQuotaPolicy {
  const raw = objectValue(value);
  const window = optionalString(raw.window) ?? "minute";
  if (!QUOTA_WINDOWS.includes(window as BackfillQuotaPolicy["window"])) {
    throw new HttpError(422, "invalid quota_policy.window");
  }
  return {
    window: window as BackfillQuotaPolicy["window"],
    limit_count: boundedInteger(raw.limit_count, 10, 1, 1000, "quota_policy.limit_count"),
  };
}

export function assertSupportedStrategy(connectorKey: string, strategy: BackfillStrategy): void {
  if (!["arxiv_api", "openalex_api", "semantic_scholar_api"].includes(connectorKey)) {
    throw new HttpError(422, "History import is not supported by this connector");
  }
  if (!["date_window", "page_cursor"].includes(strategy.window_unit)) {
    throw new HttpError(422, "The connector does not support this history import strategy");
  }
  if (strategy.history_mode === "all_available" && strategy.window_unit !== "date_window") {
    throw new HttpError(422, "All available history requires date_window pagination");
  }
}

/**
 * Deterministically plans the bounded segments for a history import strategy.
 * Stops as soon as the max_items budget is exhausted so no zero-item segment
 * is ever emitted (a segment that fetches nothing would still cost a job and
 * a quota unit).
 */
export function planSegments(strategy: BackfillStrategy): BackfillSegmentWindow[] {
  if (strategy.window_unit !== "date_window") return planCursorSegments(strategy.max_items, strategy.monitoring_field ?? "submittedDate");
  return planDateWindowSegments(strategy);
}

export function resolveStrategyBounds(strategy: BackfillStrategy, now = new Date()): BackfillStrategy {
  if (strategy.history_mode === "all_available") {
    const to = strategy.to ? new Date(strategy.to) : now;
    if (Number.isNaN(to.getTime())) throw new HttpError(422, "invalid strategy.to");
    return {
      ...strategy,
      from: ARXIV_HISTORY_FLOOR,
      to: to.toISOString(),
    };
  }
  return strategy;
}

function planCursorSegments(maxItems: number, monitoringField: "submittedDate" | "lastUpdatedDate"): BackfillSegmentWindow[] {
  const count = Math.ceil(maxItems / 100);
  return Array.from({ length: count }, (_, index) => ({
    cursor: index,
    max_items: Math.min(100, maxItems - index * 100),
    monitoring_field: monitoringField,
  }));
}

function planDateWindowSegments(strategy: BackfillStrategy): BackfillSegmentWindow[] {
  const end = strategy.to ? new Date(strategy.to) : new Date();
  const start = strategy.from ? new Date(strategy.from) : new Date(end.getTime() - 90 * 86400000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw new HttpError(422, "invalid date window");
  }

  const windows: Array<{ from: string; to: string }> = [];
  let cursor = end;
  while (cursor > start && windows.length < 1000) {
    const from = new Date(Math.max(start.getTime(), cursor.getTime() - strategy.window_size * 86400000));
    windows.push({ from: from.toISOString(), to: cursor.toISOString() });
    cursor = from;
  }

  // The strategy carries the budget used by standalone Source plans. Project
  // Research supplies its operation-owned budget here while creating the
  // segments; execution applies the remaining operation budget when it starts
  // a window. Pre-allocating the budget here makes an exactly-full page look
  // partial even when later windows still exist.
  return windows.map((window) => ({
    ...window,
    max_items: strategy.max_items,
    monitoring_field: strategy.monitoring_field ?? "submittedDate",
  }));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, field: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(422, `${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
