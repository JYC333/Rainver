import type { ApiPlanUsageWindow } from "@rainver/protocol";

export interface PlanUsageSource {
  vendor: "minimax" | "kimi" | "zai";
  url: string;
}

/** Exact official origins only: a proxy/custom endpoint must never receive another site's key. */
export function planUsageSource(baseUrl: string): PlanUsageSource | null {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return null; }
  if (base.protocol !== "https:" || base.username || base.password || base.port || base.search || base.hash) return null;
  if (["api.minimaxi.com", "api.minimax.io"].includes(base.hostname)) {
    return { vendor: "minimax", url: `https://${base.hostname === "api.minimaxi.com" ? "www.minimaxi.com" : "www.minimax.io"}/v1/token_plan/remains` };
  }
  if (["api.kimi.com", "api.kimi.ai"].includes(base.hostname) && /^\/coding(?:\/v1)?\/?$/.test(base.pathname)) {
    return { vendor: "kimi", url: `${base.origin}/coding/v1/usages` };
  }
  if (["api.z.ai", "open.bigmodel.cn"].includes(base.hostname) && /^\/api\/(?:coding\/paas\/v4|anthropic)\/?$/.test(base.pathname)) {
    return { vendor: "zai", url: `${base.origin}/api/monitor/usage/quota/limit` };
  }
  return null;
}

type Row = Record<string, unknown>;
function row(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.map(row) : []; }
function number(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function percent(value: unknown): number | null {
  const n = number(value);
  return n !== null && n <= 100 ? n : null;
}
function reset(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) && t > 0 && t < 8.64e15 ? new Date(t).toISOString() : null;
}
/**
 * MiniMax's own CLI (`mmx-cli` 1.0.28, `QuotaModelRemain`) treats
 * `end_time`/`weekly_end_time` as epoch milliseconds and
 * `remains_time`/`weekly_remains_time` as millisecond durations. A future
 * end wins; one already past (a window not yet restarted), below epoch-ms
 * magnitude (seconds) or beyond a month (microseconds) is not a reset time,
 * and the duration is used instead. Neither is ever rescaled by guesswork.
 */
const MAX_RESET_HORIZON_MS = 31 * 24 * 60 * 60 * 1000;
function miniMaxReset(end: unknown, remains: unknown, now: number): string | null {
  const plausible = (at: number | null) => at !== null && at > now && at <= now + MAX_RESET_HORIZON_MS;
  const at = number(end);
  if (at !== null && at >= 1e12 && plausible(at)) return reset(at);
  const left = number(remains);
  return left !== null && left > 0 && plausible(now + left) ? reset(now + left) : null;
}
function usedFromDetail(detail: Row): number | null {
  const limit = number(detail.limit);
  const used = number(detail.used);
  const remaining = number(detail.remaining);
  if (!limit) return null;
  return used !== null ? Math.min(100, used / limit * 100)
    : remaining !== null && remaining <= limit ? (limit - remaining) / limit * 100 : null;
}
function window(id: string, label: string, used: number | null, resets: string | null): ApiPlanUsageWindow | null {
  return used === null ? null : { id, label, used_pct: used, resets_at: resets };
}
function compact(values: (ApiPlanUsageWindow | null)[]): ApiPlanUsageWindow[] { return values.filter((v): v is ApiPlanUsageWindow => v !== null); }

/** MiniMax's count named usage_count is remaining, not consumed. Prefer current percentage meters. */
export function parseMiniMaxPlanUsage(value: unknown, now = Date.now()): ApiPlanUsageWindow[] {
  const root = row(value);
  const status = row(root.base_resp).status_code;
  if (status !== undefined && status !== 0) return [];
  const models = rows(root.model_remains);
  // New plans share a general pool. Never add/average equivalent model meters.
  const general = models.find(m => m.model_name === "general");
  return (general ? [general] : models.filter(m => typeof m.model_name === "string" && /^MiniMax-M/i.test(m.model_name))).flatMap((m, index) => {
    const name = general ? "" : String(m.model_name);
    const remaining = percent(m.current_interval_remaining_percent);
    const total = number(m.current_interval_total_count);
    const left = number(m.current_interval_usage_count);
    const used = remaining !== null ? 100 - remaining
      : total && left !== null && left <= total ? (total - left) / total * 100 : null;
    const weekly = percent(m.current_weekly_remaining_percent);
    return compact([
      window(`session-${index}`, name ? `${name} · 5h` : "5h", used, miniMaxReset(m.end_time, m.remains_time, now)),
      window(`week-${index}`, name ? `${name} · 7d` : "7d", weekly === null ? null : 100 - weekly, miniMaxReset(m.weekly_end_time, m.weekly_remains_time, now)),
    ]);
  });
}

export function parseKimiPlanUsage(value: unknown): ApiPlanUsageWindow[] {
  const root = row(value);
  const usage = row(root.usage);
  // Prefer authoritative limit/used counters over the convenience ratio block.
  const weekly = usedFromDetail(usage);
  const windows = rows(root.limits).flatMap((limit, index) => {
    const spec = row(limit.window), detail = row(limit.detail);
    const duration = number(spec.duration);
    const unit = spec.timeUnit;
    const label = unit === "TIME_UNIT_MINUTE" && duration === 300 ? "5h"
      : unit === "TIME_UNIT_DAY" && duration === 7 ? "7d" : null;
    return label ? compact([window(`limit-${index}`, label, usedFromDetail(detail), reset(detail.resetTime))]) : [];
  });
  if (weekly !== null) windows.push({ id: "week", label: "7d", used_pct: weekly, resets_at: reset(usage.resetTime) });
  if (windows.length) return windows;
  return compact(Object.entries(row(root.usages)).map(([id, value]) => {
    const r = row(value), ratio = number(r.used_ratio ?? r.usedRatio);
    const label = id === "limit_5h" ? "5h" : id === "limit_7d" ? "7d"
      : id === "limit_month_total" ? "1mo" : id === "limit_month_code" ? "Code · 1mo" : null;
    return label && ratio !== null && ratio <= 1 ? window(id, label, ratio * 100, reset(r.reset_time ?? r.resetTime)) : null;
  }));
}

export function parseZaiPlanUsage(value: unknown): ApiPlanUsageWindow[] {
  const root = row(value);
  if (root.success === false || (root.code !== undefined && root.code !== 200 && root.code !== 0)) return [];
  return rows(row(root.data).limits).flatMap((limit, index) => {
    const type = limit.type;
    const label = type === "TOKENS_LIMIT" ? "5h" : type === "TIME_LIMIT" ? "MCP · 1mo"
      : type === "CREDIT_LIMIT" && limit.unit === 3 && limit.number === 5 ? "5h"
      : type === "CREDIT_LIMIT" && limit.unit === 6 && limit.number === 1 ? "7d" : null;
    return label ? compact([window(`limit-${index}`, label, percent(limit.percentage), reset(limit.nextResetTime))]) : [];
  });
}

export async function collectPlanUsage(source: PlanUsageSource, apiKey: string, fetcher: typeof fetch = fetch): Promise<ApiPlanUsageWindow[]> {
  // No redirects, vendor response bodies or low-level errors containing request secrets escape this boundary.
  try {
    const response = await fetcher(source.url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: source.vendor === "zai" ? apiKey : `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Rainver/0.0.1" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1_048_576) throw new Error("Response too large");
    const data: unknown = JSON.parse(text);
    const windows = source.vendor === "minimax" ? parseMiniMaxPlanUsage(data)
      : source.vendor === "kimi" ? parseKimiPlanUsage(data) : parseZaiPlanUsage(data);
    if (!windows.length) throw new Error("No measured quota windows");
    return windows;
  } catch {
    throw new Error("Plan usage query failed. Check the subscription key, plan status and network, then retry.");
  }
}
