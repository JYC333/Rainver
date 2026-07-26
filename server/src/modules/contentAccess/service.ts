import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool";
import type { ServerConfig } from "../../config";
import {
  contentResourceDefinition,
  type ContentResourceDefinition,
} from "../access/contentAccessRegistry";
import { contentAccessLevelSql, contentAccessSql } from "../access/contentAccessSql";
import {
  isContentAccessLevel,
  isContentVisibility,
  type ContentAccessDecision,
  type ContentAccessLevel,
  type ContentVisibility,
} from "../access/contentAccessTypes";
import { dbPool, HttpError, type Queryable, type SpaceUserIdentity, withDbTransaction } from "../routeUtils/common";
import { isSpaceOwnerOrAdmin } from "../access/roles";

interface ResourcePolicyRow {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
  project_folder_id: string | null;
  project_id: string | null;
}

interface GrantRow {
  grantee_user_id: string;
  access_level: string;
  created_at: string;
  updated_at: string;
}

export interface ContentAccessUpdate {
  visibility: ContentVisibility;
  access_level: ContentAccessLevel;
  grants: Array<{ user_id: string; access_level: ContentAccessLevel }>;
}

export class ContentAccessService {
  constructor(private readonly pool: Pool) {}

  static fromConfig(config: ServerConfig): ContentAccessService {
    return new ContentAccessService(dbPool(config));
  }

  async decision(
    identity: SpaceUserIdentity,
    resourceType: string,
    resourceId: string,
  ): Promise<ContentAccessDecision> {
    const definition = requireDefinition(resourceType);
    const alias = "content_resource";
    const result = await this.pool.query<{ effective_access_level: string }>(
      `SELECT ${contentAccessLevelSql({ definition, alias, userExpr: "$3" })} AS effective_access_level
         FROM ${definition.tableName} ${alias}
        WHERE ${alias}.space_id = $1
          AND ${alias}.id = $2
          AND ${activeSql(definition, alias)}
          AND ${contentAccessSql({ definition, alias, userExpr: "$3" })}
        LIMIT 1`,
      [identity.spaceId, resourceId, identity.userId],
    );
    const level = result.rows[0]?.effective_access_level;
    return isContentAccessLevel(level) ? level : "deny";
  }

  async getPolicy(identity: SpaceUserIdentity, resourceType: string, resourceId: string) {
    const definition = requireDefinition(resourceType);
    const resource = await this.loadResource(this.pool, definition, identity.spaceId, resourceId);
    if (!resource || !(await this.canManage(this.pool, identity, resource))) {
      throw new HttpError(404, "Content not found");
    }
    const grants = await this.loadGrants(this.pool, identity.spaceId, resourceType, resourceId);
    return policyOut(resourceType, resource, grants);
  }

  async updatePolicy(
    identity: SpaceUserIdentity,
    resourceType: string,
    resourceId: string,
    update: ContentAccessUpdate,
  ) {
    const definition = requireDefinition(resourceType);
    validateUpdate(update);
    return withDbTransaction(this.pool, async (client) => {
      const resource = await this.loadResource(client, definition, identity.spaceId, resourceId, true);
      if (!resource || !(await this.canManage(client, identity, resource))) {
        throw new HttpError(404, "Content not found");
      }
      if (update.visibility !== "space_shared" && !resource.owner_user_id) {
        throw new HttpError(422, "owner_user_id is required for private or selected-user content");
      }

      const grants = dedupeGrants(update.grants, resource.owner_user_id);
      if (update.visibility === "selected_users" && grants.length === 0) {
        throw new HttpError(422, "selected_users visibility requires at least one grantee");
      }
      await this.assertActiveMembers(client, identity.spaceId, grants.map((grant) => grant.user_id));

      const now = new Date().toISOString();
      await client.query(
        `UPDATE ${definition.tableName}
            SET visibility = $3, access_level = $4, updated_at = $5
          WHERE space_id = $1 AND id = $2`,
        [identity.spaceId, resourceId, update.visibility, update.access_level, now],
      );
      await client.query(
        `UPDATE content_access_grants
            SET revoked_at = $4, revoked_by_user_id = $5, updated_at = $4
          WHERE space_id = $1 AND resource_type = $2 AND resource_id = $3 AND revoked_at IS NULL`,
        [identity.spaceId, resourceType, resourceId, now, identity.userId],
      );
      if (update.visibility === "selected_users" || update.visibility === "space_shared") {
        for (const grant of grants) {
          await client.query(
            `INSERT INTO content_access_grants (
               id, space_id, resource_type, resource_id, grantee_user_id,
               granted_by_user_id, access_level, created_at, updated_at, revoked_at, revoked_by_user_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NULL, NULL)
             ON CONFLICT (space_id, resource_type, resource_id, grantee_user_id)
             DO UPDATE SET
               granted_by_user_id = EXCLUDED.granted_by_user_id,
               access_level = EXCLUDED.access_level,
               updated_at = EXCLUDED.updated_at,
               revoked_at = NULL,
               revoked_by_user_id = NULL`,
            [randomUUID(), identity.spaceId, resourceType, resourceId, grant.user_id, identity.userId, grant.access_level, now],
          );
        }
      }

      const updated = await this.loadResource(client, definition, identity.spaceId, resourceId);
      const activeGrants = await this.loadGrants(client, identity.spaceId, resourceType, resourceId);
      return policyOut(resourceType, updated!, activeGrants);
    });
  }

  private async loadResource(
    db: Queryable,
    definition: ContentResourceDefinition,
    spaceId: string,
    resourceId: string,
    forUpdate = false,
  ): Promise<ResourcePolicyRow | null> {
    const projectFolderSelect = definition.projectFolderColumn ? `${definition.projectFolderColumn} AS project_folder_id` : "NULL::varchar AS project_folder_id";
    const projectSelect = definition.projectColumn ? `${definition.projectColumn} AS project_id` : "NULL::varchar AS project_id";
    const result = await db.query<ResourcePolicyRow>(
      `SELECT id, space_id, ${definition.ownerColumn} AS owner_user_id,
              visibility, access_level, ${projectFolderSelect}, ${projectSelect}
         FROM ${definition.tableName}
        WHERE space_id = $1 AND id = $2 AND ${activeSql(definition)}
        LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [spaceId, resourceId],
    );
    return result.rows[0] ?? null;
  }

  private async canManage(
    db: Queryable,
    identity: SpaceUserIdentity,
    resource: ResourcePolicyRow,
  ): Promise<boolean> {
    const result = await db.query<{ role: string }>(
      `SELECT role FROM space_memberships
        WHERE space_id = $1 AND user_id = $2 AND status = 'active'
        LIMIT 1`,
      [identity.spaceId, identity.userId],
    );
    const role = result.rows[0]?.role;
    if (!role) return false;
    return resource.owner_user_id === identity.userId || isSpaceOwnerOrAdmin(role);
  }

  private async loadGrants(
    db: Queryable,
    spaceId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<GrantRow[]> {
    const result = await db.query<GrantRow>(
      `SELECT grantee_user_id, access_level, created_at, updated_at
         FROM content_access_grants
        WHERE space_id = $1 AND resource_type = $2 AND resource_id = $3 AND revoked_at IS NULL
        ORDER BY grantee_user_id`,
      [spaceId, resourceType, resourceId],
    );
    return result.rows;
  }

  private async assertActiveMembers(db: Queryable, spaceId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    const result = await db.query<{ user_id: string }>(
      `SELECT user_id FROM space_memberships
        WHERE space_id = $1 AND user_id = ANY($2::varchar[]) AND status = 'active'`,
      [spaceId, userIds],
    );
    const active = new Set(result.rows.map((row) => row.user_id));
    if (userIds.some((userId) => !active.has(userId))) {
      throw new HttpError(422, "All grantees must be active members of this space");
    }
  }
}

function requireDefinition(resourceType: string): ContentResourceDefinition {
  const definition = contentResourceDefinition(resourceType);
  if (!definition) throw new HttpError(404, "Content type not found");
  return definition;
}

function activeSql(definition: ContentResourceDefinition, alias?: string): string {
  if (!definition.activePredicate) return "true";
  return definition.activePredicate(alias ?? definition.tableName);
}

function validateUpdate(update: ContentAccessUpdate): void {
  if (!isContentVisibility(update.visibility)) throw new HttpError(422, "Invalid visibility");
  if (!isContentAccessLevel(update.access_level)) throw new HttpError(422, "Invalid access_level");
  if (!Array.isArray(update.grants)) throw new HttpError(422, "grants must be an array");
  for (const grant of update.grants) {
    if (!grant.user_id || !isContentAccessLevel(grant.access_level)) {
      throw new HttpError(422, "Invalid content grant");
    }
  }
}

function dedupeGrants(
  grants: ContentAccessUpdate["grants"],
  ownerUserId: string | null,
): ContentAccessUpdate["grants"] {
  const byUser = new Map<string, ContentAccessLevel>();
  for (const grant of grants) {
    if (grant.user_id !== ownerUserId) byUser.set(grant.user_id, grant.access_level);
  }
  return [...byUser].map(([user_id, access_level]) => ({ user_id, access_level }));
}

function policyOut(resourceType: string, resource: ResourcePolicyRow, grants: readonly GrantRow[]) {
  return {
    resource_type: resourceType,
    resource_id: resource.id,
    space_id: resource.space_id,
    owner_user_id: resource.owner_user_id,
    visibility: resource.visibility,
    access_level: resource.access_level,
    project_folder_id: resource.project_folder_id,
    project_id: resource.project_id,
    grants: grants.map((grant) => ({
      user_id: grant.grantee_user_id,
      access_level: grant.access_level,
      created_at: grant.created_at,
      updated_at: grant.updated_at,
    })),
  };
}
