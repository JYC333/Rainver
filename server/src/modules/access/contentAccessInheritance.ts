import type { Queryable } from "../routeUtils/common.js";
import { contentResourceDefinition } from "./contentAccessRegistry.js";

export async function inheritContentAccessGrants(
  db: Queryable,
  input: {
    spaceId: string;
    sourceResourceType: string;
    sourceResourceId: string;
    targetResourceType: string;
    targetResourceId: string;
    inheritedAt: string;
  },
): Promise<void> {
  if (!contentResourceDefinition(input.sourceResourceType)) {
    throw new Error(`Unknown source content resource type: ${input.sourceResourceType}`);
  }
  if (!contentResourceDefinition(input.targetResourceType)) {
    throw new Error(`Unknown target content resource type: ${input.targetResourceType}`);
  }
  await db.query(
    `INSERT INTO content_access_grants (
       id, space_id, resource_type, resource_id, grantee_user_id,
       granted_by_user_id, access_level, created_at, updated_at,
       revoked_at, revoked_by_user_id
     )
     SELECT gen_random_uuid()::varchar, source_grant.space_id, $4, $5,
            source_grant.grantee_user_id, source_grant.granted_by_user_id,
            source_grant.access_level, $6, $6, NULL, NULL
       FROM content_access_grants source_grant
       JOIN space_memberships grantee_membership
         ON grantee_membership.space_id = source_grant.space_id
        AND grantee_membership.user_id = source_grant.grantee_user_id
        AND grantee_membership.status = 'active'
      WHERE source_grant.space_id = $1
        AND source_grant.resource_type = $2
        AND source_grant.resource_id = $3
        AND source_grant.revoked_at IS NULL
     ON CONFLICT (space_id, resource_type, resource_id, grantee_user_id)
     DO UPDATE SET
       granted_by_user_id = EXCLUDED.granted_by_user_id,
       access_level = EXCLUDED.access_level,
       updated_at = EXCLUDED.updated_at,
       revoked_at = NULL,
       revoked_by_user_id = NULL`,
    [
      input.spaceId,
      input.sourceResourceType,
      input.sourceResourceId,
      input.targetResourceType,
      input.targetResourceId,
      input.inheritedAt,
    ],
  );
}
