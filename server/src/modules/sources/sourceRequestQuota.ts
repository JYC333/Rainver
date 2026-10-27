import { createHash } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";

export interface RequestQuotaWindow { window: "minute" | "hour" | "day"; limit: number }
interface WindowState { limit: number; used: number; reset: number }
const DURATIONS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/** The credential owner resolves a stable account group, not a connection or rotating key.
 * Endpoint group is provider-owned (not a caller URL). The result is never an authorization. */
export function sourceQuotaGroup(accountGroup: string, endpointGroup: string): string {
  if (!accountGroup || !endpointGroup) throw new Error("Missing quota identity");
  return createHash("sha256").update(JSON.stringify([accountGroup, endpointGroup])).digest("hex");
}
function validate(key: string, policy: readonly RequestQuotaWindow[]): void {
  if (!/^[a-f0-9]{64}$/.test(key) || !policy.length || policy.length > 3
    || new Set(policy.map(p => p.window)).size !== policy.length
    || policy.some(p => !DURATIONS[p.window] || !Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > 1_000_000)) {
    throw new Error("Invalid request quota policy");
  }
}

/** A standalone short transaction per physical send. Never hold it over HTTP.
 * Row lock serializes workers across processes. All windows debit together or none do.
 * UTC fixed windows: daily reset is 00:00 UTC, hourly/minute at UTC boundaries.
 * A more conservative limit persists through its current window, including omitted windows. */
export async function admitSourceRequest(pool: Pool, key: string, policy: readonly RequestQuotaWindow[], signal?: AbortSignal): Promise<{ allowed: boolean; retryAt?: string }> {
  return admitSourceRequestGroups(pool, [{ key, windows: policy }], signal);
}

/** Account-wide windows and narrower endpoint windows are locked/debited together.
 * Sorting keeps two workers taking overlapping groups from deadlocking. */
export async function admitSourceRequestGroups(pool: Pool, groups: readonly { key: string; windows: readonly RequestQuotaWindow[] }[], signal?: AbortSignal): Promise<{ allowed: boolean; retryAt?: string }> {
  if (!groups.length || groups.length > 8 || new Set(groups.map(g => g.key)).size !== groups.length) throw new Error("Invalid quota groups");
  for (const group of groups) validate(group.key, group.windows);
  signal?.throwIfAborted();
  return withTransaction(pool, async db => {
    signal?.throwIfAborted();
    const locked: { key: string; states: Partial<Record<RequestQuotaWindow["window"], WindowState>>; cooldown: number; original: string }[] = [];
    for (const {key} of [...groups].sort((a,b) => a.key.localeCompare(b.key))) {
      await db.query(`INSERT INTO source_request_quota_state (group_key, windows_json) VALUES ($1,'{}'::jsonb) ON CONFLICT DO NOTHING`, [key]);
      const { rows: [row] } = await db.query<{ windows_json: Partial<Record<RequestQuotaWindow["window"], WindowState>>; cooldown_until: string | null }>(
        `SELECT windows_json, cooldown_until FROM source_request_quota_state WHERE group_key=$1 FOR UPDATE`, [key]);
      locked.push({key, states:row.windows_json, original:JSON.stringify(row.windows_json), cooldown:row.cooldown_until ? new Date(row.cooldown_until).getTime() : 0});
    }
    const {rows:[clock]} = await db.query<{now_ms:string}>(`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms`);
    const now = Number(clock.now_ms);
    for (const group of groups) {
      const states = locked.find(row => row.key === group.key)!.states;
      for (const p of group.windows) {
        const old = states[p.window];
        states[p.window] = !old || old.reset <= now
          ? { limit: p.limit, used: 0, reset: (Math.floor(now / DURATIONS[p.window]) + 1) * DURATIONS[p.window] }
          : { ...old, limit: Math.min(old.limit, p.limit) };
      }
    }
    const active = locked.flatMap(row => Object.values(row.states)).filter((v): v is WindowState => !!v && v.reset > now);
    const blockedUntil = Math.max(0, ...locked.map(row => row.cooldown), ...active.filter(v => v.used >= v.limit).map(v => v.reset));
    signal?.throwIfAborted();
    if (blockedUntil <= now) for (const state of active) state.used++;
    for (const row of locked) if (JSON.stringify(row.states) !== row.original) await db.query(`UPDATE source_request_quota_state SET windows_json=$2::jsonb WHERE group_key=$1`, [row.key, JSON.stringify(row.states)]);
    signal?.throwIfAborted();
    return blockedUntil > now ? { allowed: false, retryAt: new Date(blockedUntil).toISOString() } : { allowed: true };
  });
}

/** Explicit 1s..24h cooldown; invalid/missing headers default to 60s.
 * Parse and clamp with the DB clock, never with a worker's clock. Sorted locks
 * atomically extend account and all endpoint groups without shortening them. */
export const SOURCE_MAX_COOLDOWN_SECONDS = 86_400;
export async function coolDownSourceRequests(pool: Pool, keys: string | readonly string[], retryAfter: string | null): Promise<string> {
  const groups = [...new Set(typeof keys === "string" ? [keys] : keys)].sort();
  if (!groups.length || groups.length > 8 || groups.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error("Invalid quota identity");
  const raw = retryAfter?.trim() ?? "";
  const delta = /^\d+$/.test(raw) ? Math.min(Number(raw), SOURCE_MAX_COOLDOWN_SECONDS) : null;
  const date = delta === null && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw) ? Date.parse(raw) : NaN;
  return withTransaction(pool, async db => {
    for (const key of groups) {
      await db.query(`INSERT INTO source_request_quota_state (group_key, windows_json) VALUES ($1,'{}'::jsonb) ON CONFLICT DO NOTHING`, [key]);
      await db.query(`SELECT group_key FROM source_request_quota_state WHERE group_key=$1 FOR UPDATE`, [key]);
    }
    const result=await db.query<{cooldown_until:string}>(`UPDATE source_request_quota_state SET cooldown_until=GREATEST(cooldown_until,
      clock_timestamp() + GREATEST(1,LEAST(86400,COALESCE($2::double precision,
        extract(epoch FROM ($3::timestamptz-clock_timestamp())),60))) * interval '1 second')
      WHERE group_key=ANY($1::text[]) RETURNING cooldown_until`, [groups, delta, Number.isFinite(date) ? new Date(date).toISOString() : null]);
    return new Date(Math.max(...result.rows.map(row=>new Date(row.cooldown_until).getTime()))).toISOString();
  });
}
