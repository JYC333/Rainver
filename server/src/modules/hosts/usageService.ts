import type { HostUsageQuota } from "@rainver/protocol";
import type { Pool } from "../../db/pool.js";
import { sharedHostConnectionRegistry, type HostConnectionRegistry } from "./connectionRegistry.js";
import { hasSubscriptionQuota, normalizeHostCapabilities } from "./capabilities.js";
export { hasSubscriptionQuota };
import { acpRuntimeProbe } from "./runtimeProbes.js";

/**
 * Subscription quota, read on the host and cached here.
 *
 * Before ADR 0016 this ran beside the server against a credential the
 * broker had copied into a profile directory it owned. Nothing brokers a
 * credential any more, so the control plane asks the host and keeps only the
 * numbers. Nothing decides anything from them: they are shown on the host
 * card so someone can see a subscription running out before a Run does.
 */
export interface HostUsageRow {
  host_id: string;
  adapter_type: string;
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
  return {
    available: row.available === true,
    session_pct: typeof row.session_pct === "number" ? row.session_pct : null,
    session_resets: typeof row.session_resets === "string" ? row.session_resets : null,
    week_pct: typeof row.week_pct === "number" ? row.week_pct : null,
    week_resets: typeof row.week_resets === "string" ? row.week_resets : null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

export async function readHostUsage(pool: Pool, hostId: string): Promise<HostUsageRow[]> {
  const result = await pool.query<{
    host_id: string;
    adapter_type: string;
    installation: string;
    quota_json: unknown;
    checked_at: string;
  }>(
    `SELECT host_id, adapter_type, installation, quota_json, checked_at
       FROM host_runtime_usage
      WHERE host_id = $1
      ORDER BY adapter_type, installation`,
    [hostId],
  );
  return result.rows.map((row) => ({
    host_id: row.host_id,
    adapter_type: row.adapter_type,
    installation: row.installation,
    quota: quotaOf(row.quota_json),
    checked_at: row.checked_at,
  }));
}

async function writeHostUsage(pool: Pool, hostId: string, adapterType: string, installation: string, quota: HostUsageQuota): Promise<string> {
  const checkedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO host_runtime_usage (host_id, adapter_type, installation, quota_json, checked_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (host_id, adapter_type, installation)
     DO UPDATE SET quota_json = EXCLUDED.quota_json, checked_at = EXCLUDED.checked_at`,
    [hostId, adapterType, installation, JSON.stringify(quota), checkedAt],
  );
  return checkedAt;
}

/**
 * Asks one copy on one host, and caches whatever it says. An unreadable copy
 * is cached too — "not logged in" is a stable answer, and re-asking it every
 * few seconds only wastes a CLI launch.
 */
export async function refreshHostUsage(
  pool: Pool,
  hostId: string,
  adapterType: string,
  installation: string,
  registry: HostConnectionRegistry = sharedHostConnectionRegistry,
): Promise<HostUsageRow> {
  const quota = hasSubscriptionQuota(adapterType)
    ? await registry.requestUsageProbe(hostId, {
      adapter_type: adapterType,
      installation,
      // The adapter spec is the source for where a runtime keeps its
      // credential; a managed copy's manifest has it too, but the machine's
      // own installation has no manifest to read it from.
      login: acpRuntimeProbe(adapterType)?.login ?? null,
    })
    : {
      available: false,
      session_pct: null,
      session_resets: null,
      week_pct: null,
      week_resets: null,
      error: `${adapterType} reports no subscription quota.`,
    };
  const checkedAt = await writeHostUsage(pool, hostId, adapterType, installation, quota);
  return { host_id: hostId, adapter_type: adapterType, installation, quota, checked_at: checkedAt };
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
    for (const [adapterType, copies] of Object.entries(capabilities.installations)) {
      if (!hasSubscriptionQuota(adapterType)) continue;
      for (const copy of copies) {
        if (copy.logged_in === false) continue;
        await refreshHostUsage(pool, host.id, adapterType, copy.id, registry);
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
export interface HostRuntimeChange {
  id: string;
  host_id: string;
  host_name: string;
  adapter_type: string;
  action: "install" | "upgrade" | "rollback" | "remove";
  from_version: string | null;
  to_version: string | null;
  actor_user_id: string | null;
  created_at: string;
}

export async function recordHostRuntimeChange(pool: Pool, input: {
  hostId: string;
  adapterType: string;
  action: HostRuntimeChange["action"];
  fromVersion: string | null;
  toVersion: string | null;
  actorUserId: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO host_runtime_changes
       (id, host_id, adapter_type, action, from_version, to_version, actor_user_id, created_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, $3, $4, $5, $6, now())`,
    [input.hostId, input.adapterType, input.action, input.fromVersion, input.toVersion, input.actorUserId],
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
    `SELECT change.id, change.host_id, host.name AS host_name, change.adapter_type,
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
  adapterType: string;
  installation: string;
  quota: { rate_limit_type: string; utilization: number; resets_at: number };
}): Promise<void> {
  if (!hasSubscriptionQuota(input.adapterType)) return;
  const cached = (await readHostUsage(pool, input.hostId))
    .find((row) => row.adapter_type === input.adapterType && row.installation === input.installation);
  const pct = Math.max(0, Math.min(100, Math.round(input.quota.utilization * 100)));
  const resets = Number.isFinite(input.quota.resets_at) && input.quota.resets_at > 0
    ? `Resets ${new Date(input.quota.resets_at * 1000).toISOString()}`
    : null;
  // Anthropic names the five-hour window `five_hour`; anything else is the
  // longer one. An unrecognised name is not guessed at.
  const window = input.quota.rate_limit_type === "five_hour"
    ? "session"
    : input.quota.rate_limit_type.includes("seven") || input.quota.rate_limit_type.includes("week")
      ? "week"
      : null;
  if (!window) return;
  const quota: HostUsageQuota = {
    ...(cached?.quota ?? { available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: null }),
    ...(window === "session" ? { session_pct: pct, session_resets: resets } : { week_pct: pct, week_resets: resets }),
    error: null,
  };
  quota.available = quota.session_pct !== null || quota.week_pct !== null;
  await writeHostUsage(pool, input.hostId, input.adapterType, input.installation, quota);
}
