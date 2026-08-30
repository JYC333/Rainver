import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { contentResourceDefinition } from "./contentAccessRegistry.js";
import {
  contentAccessLevelSql,
  contentAccessSql,
  contentOwnerFilterSql,
} from "./contentAccessSql.js";
import { isContentAccessLevel, type ContentAccessDecision } from "./contentAccessTypes.js";

export async function contentDecisionFromDb(
  db: Queryable,
  identity: SpaceUserIdentity,
  resourceType: string,
  resourceId: string,
  /**
   * `includeOversight: false` answers as the person alone, ignoring any
   * oversight authority they hold. Callers that turn a read into something
   * other people will see — a compiled turn, a published summary — pass it,
   * because oversight is audit and must not become a route to publish
   * (`architecture/SECURITY_AND_ACCESS_BOUNDARIES.md`).
   */
  options: { includeOversight?: boolean } = {},
): Promise<ContentAccessDecision> {
  const definition = contentResourceDefinition(resourceType);
  if (!definition) return "deny";
  const alias = "content_resource";
  const active = definition.activePredicate?.(alias) ?? "true";
  const includeOversight = options.includeOversight;
  const result = await db.query<{ effective_access_level: string }>(
    `SELECT ${contentAccessLevelSql({ definition, alias, userExpr: "$3", includeOversight })} AS effective_access_level
       FROM ${definition.tableName} ${alias}
      WHERE ${alias}.space_id = $1
        AND ${alias}.id = $2
        AND ${active}
        AND ${contentAccessSql({ definition, alias, userExpr: "$3", includeOversight })}
      LIMIT 1`,
    [identity.spaceId, resourceId, identity.userId],
  );
  const level = result.rows[0]?.effective_access_level;
  return isContentAccessLevel(level) ? level : "deny";
}

export async function contentOwnerFromDb(
  db: Queryable,
  identity: SpaceUserIdentity,
  resourceType: string,
  resourceId: string,
): Promise<boolean> {
  const definition = contentResourceDefinition(resourceType);
  if (!definition) return false;
  const alias = "content_resource";
  const active = definition.activePredicate?.(alias) ?? "true";
  const result = await db.query<{ one: number }>(
    `SELECT 1 AS one
       FROM ${definition.tableName} ${alias}
      WHERE ${alias}.space_id = $1
        AND ${alias}.id = $2
        AND ${active}
        AND ${contentAccessSql({ definition, alias, userExpr: "$3" })}
        AND ${contentOwnerFilterSql(resourceType, alias, "$3")}
      LIMIT 1`,
    [identity.spaceId, resourceId, identity.userId],
  );
  return result.rows.length > 0;
}
