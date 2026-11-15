import type { Queryable } from "../routeUtils/common.js";

const LOCK_PREFIX = "evolution_asset:";

/**
 * Every transaction that can change an asset's promoted version set must take
 * this transaction-scoped lock before reading that set. Keeping the lock key
 * and ordering in one module prevents a promotion and a rollback from
 * validating the same asset concurrently.
 */
export async function lockEvolutionAssets(db: Queryable, assetIds: Iterable<string>): Promise<void> {
  const keys = [...new Set([...assetIds].filter(Boolean))]
    .sort()
    .map((assetId) => `${LOCK_PREFIX}${assetId}`);
  for (const key of keys) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  }
}


/**
 * Asset creation (directly or by saving a workflow from a Run) checks the
 * Space's asset_key before inserting it; this lock makes that check hold
 * until commit. It is taken instead of, never after, an asset lock.
 */
export async function lockEvolutionAssetKeys(db: Queryable, spaceId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evolution_asset_keys:${spaceId}`]);
}
