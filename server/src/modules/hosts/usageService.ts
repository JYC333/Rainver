import { HostUsageQuotaSchema, type HostUsageQuota } from "@rainver/protocol";
import type { Pool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";
import { sharedHostConnectionRegistry, type HostConnectionRegistry } from "./connectionRegistry.js";
import { hasSubscriptionQuota, normalizeHostCapabilities } from "./capabilities.js";
export { hasSubscriptionQuota };
import { acpRuntimeProbe } from "./runtimeProbes.js";
import { accountQuota, quotaWindows, subscriptionPoolId } from "./subscriptionUsage.js";
import { withTransaction } from "../../db/tx.js";
import { HttpError } from "../routeUtils/common.js";

const loginGenerations = new Map<string, number>();
const loginScope = (hostId: string, runtimeKey: string, installation: string) => JSON.stringify([hostId, runtimeKey, installation]);

/**
 * A revoked host's cache stays as it was: a probe that outlived the revoke does not write.
 * FOR SHARE holds the host row until the cache write commits, so a revoke
 * (an UPDATE of that row) either commits first and this check sees it, or
 * waits for the write and then removes access. Lock order is always the
 * scope's advisory lock, then the host row; revoke takes only the row.
 */
async function requireLiveHost(client: Queryable, hostId: string): Promise<void> {
  const live = await client.query("SELECT 1 FROM hosts WHERE id = $1 AND status <> 'revoked' FOR SHARE", [hostId]);
  if (live.rowCount === 0) throw new HttpError(404, "Host not found");
}

/** A login/logout supersedes cached and in-flight readings, never credentials. */
export async function invalidateHostUsage(pool: Pool, hostId: string, runtimeKey: string, installation: string): Promise<void> {
  const key = loginScope(hostId, runtimeKey, installation);
  loginGenerations.set(key, (loginGenerations.get(key) ?? 0) + 1);
  await withTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`host-usage:${key}`]);
    await client.query("DELETE FROM host_runtime_usage WHERE host_id = $1 AND runtime_key = $2 AND installation = $3", [hostId, runtimeKey, installation]);
  });
}

/**
 * Subscription quota, read on the host and cached here. The control plane
 * asks the host and keeps only the numbers (ADR 0016). Do not copy a
 * credential into a profile directory to read them beside the server. Usage
 * projects these readings by account; Command Center links to that projection.
 * One gate reads the connection cache: an
 * Agent-triggered Room turn waits while its login is past the Space's reserve
 * line (`rooms/quotaGate.ts`).
 */
interface HostUsageRow {
  pool_id: string;
  host_id: string;
  runtime_key: string;
  installation: string;
  quota: HostUsageQuota;
  checked_at: string;
}


/**
 * Three hours, the cadence the CLI-profile refresh used. A five-hour session
 * window moves slowly enough that this is never the freshest number a card
 * could show; the refresh button is, and it is one click away.
 */
export const HOST_USAGE_REFRESH_INTERVAL_SECONDS = 3 * 60 * 60;

function quotaOf(value: unknown): HostUsageQuota {
  const row = (value ?? {}) as Partial<HostUsageQuota>;
  return accountQuota({
    account: HostUsageQuotaSchema.shape.account.safeParse(row.account).data,
    account_display: HostUsageQuotaSchema.shape.account_display.safeParse(row.account_display).data,
    window_checked_at: HostUsageQuotaSchema.shape.window_checked_at.safeParse(row.window_checked_at).data,
    windows: HostUsageQuotaSchema.shape.windows.safeParse(row.windows).data,
    available: row.available === true,
    session_pct: typeof row.session_pct === "number" ? row.session_pct : null,
    session_resets: typeof row.session_resets === "string" ? row.session_resets : null,
    week_pct: typeof row.week_pct === "number" ? row.week_pct : null,
    week_resets: typeof row.week_resets === "string" ? row.week_resets : null,
    error: typeof row.error === "string" ? row.error : null,
  });
}

export async function readHostUsage(pool: Pool, hostId: string): Promise<HostUsageRow[]> {
  const result = await pool.query<{
    host_id: string;
    runtime_key: string;
    installation: string;
    quota_json: unknown;
    checked_at: string;
  }>(
    `SELECT host_id, runtime_key, installation, quota_json, checked_at
       FROM host_runtime_usage
      WHERE host_id = $1
      ORDER BY runtime_key, installation`,
    [hostId],
  );
  return result.rows.map((row) => ({
    pool_id: subscriptionPoolId(row.host_id, row.runtime_key, row.installation, quotaOf(row.quota_json).account),
    host_id: row.host_id,
    runtime_key: row.runtime_key,
    installation: row.installation,
    quota: quotaOf(row.quota_json),
    checked_at: row.checked_at,
  }));
}

async function writeHostUsage(pool: Pool, hostId: string, runtimeKey: string, installation: string, quota: HostUsageQuota, checkedAt = new Date().toISOString(), generation?: number): Promise<string> {
  quota.window_checked_at ??= Object.fromEntries(quotaWindows(quota).map(window => [window.id, checkedAt]));
  await withTransaction(pool, async client => {
    const key = loginScope(hostId, runtimeKey, installation);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`host-usage:${key}`]);
    if (generation !== undefined && generation !== (loginGenerations.get(key) ?? 0)) throw new HttpError(409, "The CLI login changed during this check. Refresh usage again.");
    await requireLiveHost(client, hostId);
    await client.query(
    `INSERT INTO host_runtime_usage (host_id, runtime_key, installation, quota_json, checked_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (host_id, runtime_key, installation)
     DO UPDATE SET quota_json = EXCLUDED.quota_json, checked_at = EXCLUDED.checked_at`,
    [hostId, runtimeKey, installation, JSON.stringify(quota), checkedAt],
  );
  });
  return checkedAt;
}

/**
 * Does this unreadable answer end the cached reading?
 *
 * A login, entitlement or installation answer does: the copy logged out, its
 * login expired or lost its scope, the vendor refused the credential, or the
 * copy is gone. Its old account and numbers must not keep standing in for it.
 * "Offline", "did not answer in time", "unreachable", an upgrade in progress
 * or a vendor 429/5xx says nothing about the window, so a readable reading
 * stays, keeps its original measurement clock and only gains the failure.
 * An explicit `account: null` is the host saying the login changed under the
 * probe; that always ends it. Unknown text keeps the reading: the admission
 * gate must not lose a 90 % reading to a probe it could not interpret.
 */
const TRANSIENT_USAGE_FAILURE = /offline|did not answer|in time|before the check ended|unreachable|being upgraded|retry in a moment|could not (?:start|be started)|HTTP (?:408|429|5\d\d)\b/i;
const LOGIN_USAGE_FAILURE = /log ?in|logged|sign(?:ed)? ?in|expired|scope|unauthori[sz]ed|forbidden|authenticat|HTTP 40[13]\b|\b40[13]\b|not have .+ installed|reinstall|account changed|no subscription quota/i;
export function usageFailureEndsReading(quota: Pick<HostUsageQuota, "account" | "error">): boolean {
  if (quota.account === null) return true;
  const error = quota.error ?? "";
  return !TRANSIENT_USAGE_FAILURE.test(error) && LOGIN_USAGE_FAILURE.test(error);
}

/** Records a transient failure on a readable reading without making it look fresh. */
async function markReadingUnrefreshed(pool: Pool, hostId: string, runtimeKey: string, installation: string, error: string | null, generation: number): Promise<HostUsageRow | null> {
  return withTransaction(pool, async client => {
    const key = loginScope(hostId, runtimeKey, installation);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`host-usage:${key}`]);
    if (generation !== (loginGenerations.get(key) ?? 0)) throw new HttpError(409, "The CLI login changed during this check. Refresh usage again.");
    await requireLiveHost(client, hostId);
    const result = await client.query<{ quota_json: unknown; checked_at: string }>(
      `UPDATE host_runtime_usage SET quota_json = jsonb_set(quota_json, '{error}', to_jsonb($4::text))
        WHERE host_id = $1 AND runtime_key = $2 AND installation = $3 AND quota_json->'available' = 'true'::jsonb
        RETURNING quota_json, checked_at`,
      [hostId, runtimeKey, installation, error ?? "This copy could not be read."],
    );
    const row = result.rows[0];
    if (!row) return null;
    const quota = quotaOf(row.quota_json);
    return { pool_id: subscriptionPoolId(hostId, runtimeKey, installation, quota.account), host_id: hostId, runtime_key: runtimeKey, installation, quota, checked_at: new Date(row.checked_at).toISOString() };
  });
}

/**
 * One probe per copy and login at a time. The Usage page (mount, remount,
 * Space switch, refresh-all), the per-pool button and the admission gate all
 * join it rather than launching the CLI again. Every caller is authorized for
 * the copy before it asks, and the row is the copy's own cache, so a joiner
 * learns nothing its own read would not. A login change starts a new key.
 */
const inFlightProbes = new Map<string, Promise<HostUsageRow>>();

/**
 * Asks one copy on one host, and caches its answer. An unreadable answer
 * replaces the cache when it ends the login's reading ("not logged in" is a
 * stable answer); a transient one keeps a readable reading
 * (`usageFailureEndsReading`).
 */
export function refreshHostUsage(
  pool: Pool,
  hostId: string,
  runtimeKey: string,
  installation: string,
  registry: HostConnectionRegistry = sharedHostConnectionRegistry,
): Promise<HostUsageRow> {
  const scope = loginScope(hostId, runtimeKey, installation);
  const key = JSON.stringify([scope, loginGenerations.get(scope) ?? 0]);
  const existing = inFlightProbes.get(key);
  if (existing) return existing;
  const probe = probeAndCache(pool, hostId, runtimeKey, installation, registry)
    .finally(() => { if (inFlightProbes.get(key) === probe) inFlightProbes.delete(key); });
  inFlightProbes.set(key, probe);
  return probe;
}

async function probeAndCache(
  pool: Pool,
  hostId: string,
  runtimeKey: string,
  installation: string,
  registry: HostConnectionRegistry,
): Promise<HostUsageRow> {
  const generation = loginGenerations.get(loginScope(hostId, runtimeKey, installation)) ?? 0;
  const quota = hasSubscriptionQuota(runtimeKey)
    ? await registry.requestUsageProbe(hostId, {
      runtime_key: runtimeKey,
      installation,
      // The adapter spec is the source for where a runtime keeps its
      // credential; a managed copy's manifest has it too, but the machine's
      // own installation has no manifest to read it from.
      login: acpRuntimeProbe(runtimeKey)?.login ?? null,
      state: acpRuntimeProbe(runtimeKey)?.state ?? null,
    })
    : {
      available: false,
      session_pct: null,
      session_resets: null,
      week_pct: null,
      week_resets: null,
      error: `${runtimeKey} reports no subscription quota.`,
    };
  if (!quota.available && !usageFailureEndsReading(quota)) {
    const kept = await markReadingUnrefreshed(pool, hostId, runtimeKey, installation, quota.error, generation);
    if (kept) return kept;
  }
  if (runtimeKey === "claude_code" && quota.available) {
    const cached = (await readHostUsage(pool, hostId)).find(row => row.runtime_key === runtimeKey && row.installation === installation);
    const reported = new Set(quota.windows?.map(item => item.id) ?? []);
    const sameAccount = cached?.quota.account && quota.account
      ? subscriptionPoolId(hostId, runtimeKey, installation, cached.quota.account) === subscriptionPoolId(hostId, runtimeKey, installation, quota.account)
      : cached?.quota.account === undefined && quota.account === undefined;
    const retained = (sameAccount ? cached?.quota.windows ?? [] : []).filter(item =>
      /^(five_hour|seven_day)_[a-z0-9_]+$/.test(item.id) && !reported.has(item.id)
      && item.resets !== null && Date.parse(item.resets.replace(/^Resets /, "")) > Date.now());
    if (retained.length) {
      const now = new Date().toISOString();
      quota.window_checked_at = Object.fromEntries([
        ...(quota.windows ?? []).map(item => [item.id, now]),
        ...retained.map(item => [item.id, cached?.quota.window_checked_at?.[item.id] ?? cached!.checked_at]),
      ]);
      quota.windows = [...(quota.windows ?? []), ...retained].slice(0, 64);
    }
  }
  const checkedAt = await writeHostUsage(pool, hostId, runtimeKey, installation, quota, undefined, generation);
  return { pool_id: subscriptionPoolId(hostId, runtimeKey, installation, quota.account), host_id: hostId, runtime_key: runtimeKey, installation, quota, checked_at: checkedAt };
}

/**
 * Every copy this host reports as logged in, across every host that is online
 * right now. A copy nobody has logged into has no quota to read, and an
 * offline host would only fill the cache with "offline".
 */
export async function refreshAllHostUsage(
  pool: Pool,
  registry: HostConnectionRegistry = sharedHostConnectionRegistry,
): Promise<number> {
  const hosts = await pool.query<{ id: string; capabilities_json: unknown }>(
    `SELECT id, capabilities_json FROM hosts WHERE status = 'online'`,
  );
  let probed = 0;
  for (const host of hosts.rows) {
    if (!registry.isOnline(host.id)) continue;
    const capabilities = normalizeHostCapabilities(host.capabilities_json);
    for (const [runtimeKey, copies] of Object.entries(capabilities.installations)) {
      if (!hasSubscriptionQuota(runtimeKey)) continue;
      for (const copy of copies) {
        if (copy.logged_in === false) continue;
        await refreshHostUsage(pool, host.id, runtimeKey, copy.id, registry);
        probed += 1;
      }
    }
  }
  return probed;
}

/**
 * What changed about a host's runtimes: an append-only record shown on the
 * Updates page beside instance updates.
 *
 * A record, not a gate: the host's own capability report is the authority on
 * what is installed now. This answers "since when", which nothing else can.
 */
interface HostRuntimeChange {
  id: string;
  host_id: string;
  host_name: string;
  runtime_key: string;
  action: "install" | "upgrade" | "rollback" | "remove";
  from_version: string | null;
  to_version: string | null;
  actor_user_id: string | null;
  created_at: string;
}

/** The one writer for `host_runtime_changes`; takes a transaction as readily as a pool. */
export async function recordHostRuntimeChange(db: Queryable, input: {
  hostId: string;
  runtimeKey: string;
  action: HostRuntimeChange["action"];
  fromVersion: string | null;
  toVersion: string | null;
  actorUserId: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO host_runtime_changes
       (id, host_id, runtime_key, action, from_version, to_version, actor_user_id, created_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, $3, $4, $5, $6, now())`,
    [input.hostId, input.runtimeKey, input.action, input.fromVersion, input.toVersion, input.actorUserId],
  );
}

/**
 * The changes this viewer may see: the instance's built-in host, plus their own
 * paired machines. Scoped the same way the host list itself is
 * (`hosts/repository.ts`'s `listVisibleTo`) — a paired host's name is usually
 * someone's computer name, and this row set would otherwise enumerate every
 * member's machines and when they touched them.
 */
export async function listHostRuntimeChanges(pool: Pool, viewerUserId: string, limit = 20): Promise<HostRuntimeChange[]> {
  const result = await pool.query<HostRuntimeChange>(
    `SELECT change.id, change.host_id, host.name AS host_name, change.runtime_key,
            change.action, change.from_version, change.to_version,
            change.actor_user_id, change.created_at
       FROM host_runtime_changes change
       JOIN hosts host ON host.id = change.host_id
      WHERE host.kind = 'server' OR host.owner_user_id = $1
      ORDER BY change.created_at DESC, change.id DESC
      LIMIT $2`,
    [viewerUserId, Math.max(1, Math.min(limit, 100))],
  );
  return result.rows;
}

/**
 * Folds a live reading from a finished Run into the cache.
 *
 * Claude reports one rate-limit window on the way past, which is fresher than
 * any scheduled probe and costs nothing to keep (ADR 0016 §7). It updates only
 * the window it names: the other one keeps whatever the last probe said rather
 * than being blanked by a partial reading.
 */
export async function mergeRunQuota(pool: Pool, input: {
  hostId: string;
  runtimeKey: string;
  installation: string;
  quota: { rate_limit_type: string; utilization: number; resets_at: number };
}): Promise<void> {
  if (!hasSubscriptionQuota(input.runtimeKey)) return;
  const generation = loginGenerations.get(loginScope(input.hostId, input.runtimeKey, input.installation)) ?? 0;
  // Only account-wide windows can update this account-wide cache. Model-
  // specific windows (for example seven_day_fable) have independent limits.
  const window = input.quota.rate_limit_type === "five_hour"
    ? "session"
    : input.quota.rate_limit_type === "seven_day"
      ? "week"
      : null;
  const modelWindow = input.runtimeKey === "claude_code" && /^(five_hour|seven_day)_[a-z0-9_]+$/.test(input.quota.rate_limit_type);
  if (!window && !modelWindow) return;
  if (!Number.isFinite(input.quota.utilization) || input.quota.utilization < 0) return;
  const cached = (await readHostUsage(pool, input.hostId))
    .find((row) => row.runtime_key === input.runtimeKey && row.installation === input.installation);
  const windowTimes = { ...(cached?.quota.window_checked_at ?? Object.fromEntries(quotaWindows(cached?.quota ?? { available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: null }).map(item => [item.id, cached!.checked_at]))) };
  windowTimes[input.quota.rate_limit_type] = new Date().toISOString();
  if (window) windowTimes[window] = windowTimes[input.quota.rate_limit_type]!;
  const pct = Math.max(0, Math.min(100, Math.round(input.quota.utilization * 100)));
  const resets = Number.isFinite(input.quota.resets_at) && input.quota.resets_at > 0
    ? `Resets ${new Date(input.quota.resets_at * 1000).toISOString()}`
    : null;
  if (!window) {
    // Model-specific events must never make the account-wide reading look fresh.
    const id = input.quota.rate_limit_type;
    const quota: HostUsageQuota = {
      ...(cached?.quota ?? { available: true, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: null }),
      window_checked_at: windowTimes,
      available: true,
      windows: [
        { id, label: id.replace(/^seven_day_/, "").replace(/^five_hour_/, "").replaceAll("_", " ") + (id.startsWith("seven_day") ? " weekly" : " session"), used_pct: pct, resets },
        ...(cached?.quota.windows ?? []).filter(item => item.id !== id),
      ].slice(0, 64),
    };
    await writeHostUsage(pool, input.hostId, input.runtimeKey, input.installation, quota, cached?.checked_at, generation);
    return;
  }
  const quota: HostUsageQuota = {
    ...(cached?.quota ?? { available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: null }),
    window_checked_at: windowTimes,
    ...(window === "session" ? { session_pct: pct, session_resets: resets } : { week_pct: pct, week_resets: resets }),
    error: null,
  };
  if (quota.windows) {
    const id = input.quota.rate_limit_type;
    const existing = quota.windows.find(item => item.id === id);
    const updated = { id, label: existing?.label ?? id.replaceAll("_", " "), used_pct: pct, resets };
    quota.windows = [...quota.windows.filter(item => item.id !== id), updated].slice(0, 64);
  }
  quota.available = quota.session_pct !== null || quota.week_pct !== null;
  await writeHostUsage(pool, input.hostId, input.runtimeKey, input.installation, quota, undefined, generation);
}
