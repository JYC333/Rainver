import type { Queryable } from "../routeUtils/common.js";
import { isOversightMode, type OversightMode } from "./contentAccessTypes.js";

/**
 * Resolves the viewer's effective Space oversight mode: the Space's
 * configured `oversight_mode` when the viewer is an active owner/admin
 * member, otherwise `'none'`. Fails closed to `'none'` on any other role,
 * inactive membership, or missing Space/membership row.
 */
export async function resolveOversightLevel(
  db: Queryable,
  spaceId: string,
  userId: string,
): Promise<OversightMode> {
  const result = await db.query<{ oversight_mode: string; role: string }>(
    `SELECT s.oversight_mode, m.role
       FROM spaces s
       JOIN space_memberships m
         ON m.space_id = s.id
        AND m.user_id = $2
        AND m.status = 'active'
      WHERE s.id = $1
      LIMIT 1`,
    [spaceId, userId],
  );
  const row = result.rows[0];
  if (!row || (row.role !== "owner" && row.role !== "admin")) return "none";
  return isOversightMode(row.oversight_mode) ? row.oversight_mode : "none";
}
