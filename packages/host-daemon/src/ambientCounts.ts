/**
 * How much ambient history each registered workspace holds, for the heartbeat.
 *
 * Counting means starting an agent process per runtime and asking it to
 * enumerate — orders of magnitude more than a heartbeat should cost, and this
 * daemon heartbeats every 15 seconds. So counts are refreshed on their own
 * slow interval and every heartbeat reports the cached value. The number is a
 * banner subtitle ("12 sessions found for this folder"); it being minutes old
 * changes nothing about what an import then actually reads.
 *
 * Nothing here is persisted: the cache lives for the life of the process,
 * exactly like the daemon's other in-memory state.
 */

import { countAmbientSessions, sanitizeFailure, type AcpLaunchResolver } from "./ambientSessions.js";
import { OWN_INSTALLATION } from "./tools.js";

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/** How long a failure is remembered before the runtime is asked again. */
const FAILURE_INTERVAL_MS = 30 * 60 * 1000;
const WINDOW_DAYS = 30;
const MAX_SESSIONS = 50;

export interface AmbientSessionCount {
  location_id: string;
  adapter_type: string;
  installation: string;
  session_count: number;
  oldest_updated_at: string | null;
  newest_updated_at: string | null;
  /** Set when the runtime could not be asked; the count is then unknown, not zero. */
  error: string | null;
}

/** The subset of a server runtime probe this module needs. */
export interface AmbientProbe {
  adapter_type: string;
  argv: string[];
  remote_host_only: boolean;
}

interface CacheEntry {
  refreshedAt: number;
  count: AmbientSessionCount;
}

const cache = new Map<string, CacheEntry>();
let refreshing = false;

function cacheKey(locationId: string, adapterType: string, installation: string): string {
  return `${locationId} ${adapterType} ${installation}`;
}

/** The counts as last measured; never blocks a heartbeat on a measurement. */
export function ambientSessionCounts(): AmbientSessionCount[] {
  return [...cache.values()].map((entry) => entry.count);
}

/**
 * Refreshes stale entries in the background.
 *
 * Only the machine's own installation is enumerated: ambient history is what
 * a person accumulated in their own copy, and a managed copy the control
 * plane installed starts empty. A managed copy that does accumulate history
 * is imported through an explicit request naming it, not discovered here.
 */
export async function refreshAmbientSessionCounts(
  workspaces: Record<string, string>,
  probes: readonly AmbientProbe[],
  resolveLaunch: AcpLaunchResolver,
  now: number = Date.now(),
): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    // A Location this machine no longer has registered must stop being
    // reported: otherwise its count is heartbeated forever and the server
    // keeps writing a row for a folder that is gone.
    const registered = new Set(Object.keys(workspaces));
    for (const key of [...cache.keys()]) {
      if (!registered.has(key.split(" ")[0] ?? "")) cache.delete(key);
    }
    for (const [locationId, cwd] of Object.entries(workspaces)) {
      for (const probe of probes) {
        if (probe.remote_host_only) continue;
        const key = cacheKey(locationId, probe.adapter_type, OWN_INSTALLATION);
        const existing = cache.get(key);
        const interval = existing?.count.error ? FAILURE_INTERVAL_MS : REFRESH_INTERVAL_MS;
        if (existing && now - existing.refreshedAt < interval) continue;
        cache.set(key, { refreshedAt: Date.now(), count: await measure(locationId, cwd, probe, resolveLaunch) });
      }
    }
  } finally {
    refreshing = false;
  }
}

async function measure(
  locationId: string,
  cwd: string,
  probe: AmbientProbe,
  resolveLaunch: AcpLaunchResolver,
): Promise<AmbientSessionCount> {
  const base = { location_id: locationId, adapter_type: probe.adapter_type, installation: OWN_INSTALLATION };
  try {
    const result = await countAmbientSessions(
      { adapter_type: probe.adapter_type, installation: OWN_INSTALLATION, argv: probe.argv },
      cwd,
      WINDOW_DAYS,
      MAX_SESSIONS,
      resolveLaunch,
    );
    if (!result) {
      // Installed, but it cannot enumerate or replay. A fact about the
      // runtime rather than an error to retry quickly, and the server uses it
      // to leave the import offer off entirely.
      return { ...base, session_count: 0, oldest_updated_at: null, newest_updated_at: null, error: "unsupported" };
    }
    // Ordered as instants, not as strings: runtimes print their timestamps
    // in their own formats, and a lexical sort over mixed formats reports the
    // wrong oldest and newest.
    const dates = result.sessions
      .map((session) => session.updated_at)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => ({ value, at: Date.parse(value) }))
      .filter((entry) => Number.isFinite(entry.at))
      .sort((left, right) => left.at - right.at);
    return {
      ...base,
      session_count: result.sessions.length,
      oldest_updated_at: dates[0]?.value ?? null,
      newest_updated_at: dates[dates.length - 1]?.value ?? null,
      error: null,
    };
  } catch (error) {
    // A count that cannot be taken is unknown, not zero: reporting zero would
    // hide a folder's history behind a runtime that happened to be busy.
    return {
      ...base,
      session_count: 0,
      oldest_updated_at: null,
      newest_updated_at: null,
      // Sanitized like every other string this daemon reports: a spawn
      // failure names an absolute path on this machine, and the control plane
      // does not learn those (ADR 0016).
      error: sanitizeFailure(error),
    };
  }
}
