import type { Queryable } from "../routeUtils/common.js";
import { readSpaceSnapshotDefaults } from "../spaces/snapshotDefaults.js";
import type { ProjectFolderRow } from "./repository.js";

export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_MAX_COUNT = 20;

export async function resolveFolderSnapshotRetention(
  db: Queryable,
  spaceId: string,
  folder: Pick<ProjectFolderRow, "snapshot_retention_days" | "snapshot_max_count">,
): Promise<{ retentionDays: number; maxCount: number }> {
  const defaults = folder.snapshot_retention_days == null || folder.snapshot_max_count == null
    ? await readSpaceSnapshotDefaults(db, spaceId)
    : null;
  return {
    retentionDays: folder.snapshot_retention_days ?? defaults?.snapshot_retention_days_default ?? DEFAULT_RETENTION_DAYS,
    maxCount: folder.snapshot_max_count ?? defaults?.snapshot_max_count_default ?? DEFAULT_MAX_COUNT,
  };
}
