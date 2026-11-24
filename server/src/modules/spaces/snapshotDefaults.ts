import type { Queryable } from "../routeUtils/common.js";

export interface SnapshotDefaults {
  snapshot_retention_days_default: number | null;
  snapshot_max_count_default: number | null;
}

/** Internal read for callers that have already established Space authority. */
export async function readSpaceSnapshotDefaults(db: Queryable, spaceId: string): Promise<SnapshotDefaults> {
  const res = await db.query<SnapshotDefaults>(
    `SELECT snapshot_retention_days_default, snapshot_max_count_default
       FROM spaces WHERE id = $1 LIMIT 1`,
    [spaceId],
  );
  return res.rows[0] ?? { snapshot_retention_days_default: null, snapshot_max_count_default: null };
}
