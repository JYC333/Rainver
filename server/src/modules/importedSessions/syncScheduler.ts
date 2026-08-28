/**
 * What makes "keep syncing" actually sync.
 *
 * Standing consent on a Location is the only thing that authorizes this: a
 * person typing in their own terminal has not thereby agreed to publish it,
 * so nothing here looks at a folder whose policy does not say `sync`.
 *
 * It hangs off the heartbeat rather than a scheduler of its own because the
 * heartbeat is the moment the control plane learns the host is reachable and
 * what it now holds — and because a sync to an offline host is only a way to
 * wait for a timeout. The interval below is the real cadence: a sync replays
 * every changed session, and each replay starts an agent process on someone's
 * laptop, so this must be rare compared to the 15-second heartbeat.
 */

import { AmbientImportPolicySchema } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { ImportedSessionService } from "./service.js";

const SYNC_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Locations already syncing, so a heartbeat arriving mid-sync does not start a
 * second one. Process-local, like the connection registry it works alongside:
 * a second server process would at worst duplicate work that is itself
 * idempotent.
 */
const inFlight = new Set<string>();
const lastRunAt = new Map<string, number>();
/**
 * When each host was last examined at all. Checked before the query, not
 * after: a daemon heartbeats every 15 seconds, and a lookup per heartbeat per
 * host is a standing load in exchange for an answer that changes on the scale
 * of a person clicking a switch.
 */
const lastLookupAt = new Map<string, number>();
const LOOKUP_INTERVAL_MS = 60 * 1000;

interface ConsentedLocation {
  location_id: string;
  space_id: string;
  owner_user_id: string;
  adapter_type: string;
  installation: string;
}

/**
 * Runs due syncs for one host's consented Locations.
 *
 * Never awaited by the heartbeat: an import takes minutes, and a heartbeat
 * that waited for one would stall the connection it arrived on. Failures are
 * swallowed here and recorded on the sync's own report instead — a heartbeat
 * is not a place to surface an import error.
 */
export function scheduleAmbientSyncs(db: Queryable, config: ServerConfig, hostId: string): void {
  const lookedUp = lastLookupAt.get(hostId) ?? 0;
  if (Date.now() - lookedUp < LOOKUP_INTERVAL_MS) return;
  lastLookupAt.set(hostId, Date.now());
  void (async () => {
    const due = await consentedLocations(db, hostId);
    for (const location of due) {
      const key = `${location.location_id} ${location.adapter_type} ${location.installation}`;
      if (inFlight.has(key)) continue;
      const last = lastRunAt.get(key) ?? 0;
      if (Date.now() - last < SYNC_INTERVAL_MS) continue;
      inFlight.add(key);
      lastRunAt.set(key, Date.now());
      try {
        // Run as the host owner, which is who consented and whose machine it
        // is; a background sync grants no authority the interactive path
        // does not already give that person.
        await new ImportedSessionService(db, config).sync(
          { spaceId: location.space_id, userId: location.owner_user_id },
          location.location_id,
          { adapter_type: location.adapter_type, installation: location.installation, initiator: "schedule" },
        );
      } catch {
        // Recorded by the next interactive sync's report; a heartbeat has no
        // reader to show this to.
      } finally {
        inFlight.delete(key);
      }
    }
  })().catch(() => undefined);
}

async function consentedLocations(db: Queryable, hostId: string): Promise<ConsentedLocation[]> {
  const result = await db.query<{
    id: string;
    space_id: string;
    owner_user_id: string | null;
    ambient_import_policy_json: unknown;
  }>(
    `SELECT wl.id, wl.space_id, h.owner_user_id, wl.ambient_import_policy_json
       FROM workspace_locations wl
       JOIN hosts h ON h.id = wl.execution_host_id
      WHERE wl.execution_host_id = $1
        AND wl.execution_host_kind = 'remote'
        AND wl.status = 'active'
        AND h.status = 'online'
        AND h.owner_user_id IS NOT NULL`,
    [hostId],
  );
  return result.rows.flatMap((row) => {
    const parsed = AmbientImportPolicySchema.safeParse(row.ambient_import_policy_json ?? {});
    if (!parsed.success || !row.owner_user_id) return [];
    return parsed.data.entries
      .filter((entry) => entry.sync)
      .map((entry) => ({
        location_id: row.id,
        space_id: row.space_id,
        owner_user_id: row.owner_user_id!,
        adapter_type: entry.adapter_type,
        installation: entry.installation,
      }));
  });
}
