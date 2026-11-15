import type { Queryable } from "../routeUtils/common.js";

/** A retained Project's content is never part of another Project's execution. */
export async function usesIsolatedAgentContext(
  db: Queryable, spaceId: string, agentId: string | null, projectId: string | null,
): Promise<boolean> {
  if (!agentId || !projectId) return false;
  const found = await db.query(
    `SELECT 1 FROM agents WHERE space_id=$1 AND id=$2
      AND access_project_id IS NOT NULL AND access_project_id<>$3`,
    [spaceId, agentId, projectId],
  );
  return found.rows.length > 0;
}
