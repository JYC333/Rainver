import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";

/**
 * Who may read and who may change what hangs off a Source connection — its
 * channels' rules and runs, its Custom Source handlers, its recipes, its
 * history imports.
 *
 * Same-Space is not the gate: a connection is `source_connection` content,
 * Project-scoped in a team Space and private in a personal one, so reading
 * anything under it takes the connection's own read decision.
 */
export async function assertSourceConnectionReadable(
  db: Queryable,
  identity: SpaceUserIdentity,
  connectionId: string,
): Promise<void> {
  if ((await contentDecisionFromDb(db, identity, "source_connection", connectionId)) === "deny") {
    throw new HttpError(404, "Source connection not found");
  }
}

/**
 * Changing it takes its owner or a Space owner/admin, who must also read it
 * in their own right: Space oversight is audit, not a route to a write.
 */
export async function assertSourceConnectionManageable(
  db: Queryable,
  identity: SpaceUserIdentity,
  connectionId: string,
): Promise<void> {
  const decision = await contentDecisionFromDb(db, identity, "source_connection", connectionId, { includeOversight: false });
  if (decision === "deny") throw new HttpError(404, "Source connection not found");
  const manager = await db.query(
    `SELECT 1
       FROM source_connections sc
      WHERE sc.space_id = $1 AND sc.id = $2
        AND (sc.owner_user_id = $3
             OR EXISTS (
               SELECT 1 FROM space_memberships sm
                WHERE sm.space_id = $1 AND sm.user_id = $3 AND sm.status = 'active'
                  AND sm.role IN ('owner', 'admin')
             ))`,
    [identity.spaceId, connectionId, identity.userId],
  );
  if (!manager.rows[0]) throw new HttpError(403, "Source owner or space admin access required");
}
