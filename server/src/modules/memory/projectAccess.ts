import type { Queryable } from "../routeUtils/common.js";
import {
  accessibleProjectIds as accessibleProjectIdsFromProjects,
  canReadProject,
} from "../projects/access.js";

/**
 * Project-level access gate for memory reads.
 *
 * Callers in this module use this function. The ACL is `projects/access.ts`.
 * Do not copy a second definition here.
 * Memory with `project_id = null` is not project-gated and should not call this.
 */
export async function canAccessProject(
  db: Queryable,
  spaceId: string,
  projectId: string,
  viewerUserId: string,
): Promise<boolean> {
  return canReadProject(db, spaceId, projectId, viewerUserId);
}

/**
 * Batched form of {@link canAccessProject} for filtering a page of rows: returns
 * the subset of `projectIds` the viewer can access, in a fixed number of queries
 * regardless of row count. Empty input short-circuits with no queries so callers
 * with no project-scoped rows pay nothing (and need no project tables present).
 */
export async function accessibleProjectIds(
  db: Queryable,
  spaceId: string,
  viewerUserId: string,
  projectIds: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  return accessibleProjectIdsFromProjects(db, spaceId, viewerUserId, projectIds);
}
