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
import { parseRunContextTaint } from "../runs/contextTaint";
import { insertProposalRow } from "../proposals/reviewPackets";
import { ContentAccessAuditService } from "./audit";
import { ContentDemotionService } from "./demotion";

interface ResourcePolicyRow {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
  project_folder_id: string | null;
  project_id: string | null;
  context_taint: unknown;
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
  project_id: string | null;
  grants: Array<{ user_id: string; access_level: ContentAccessLevel }>;
  demotion_confirmation_id?: string;
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
    await this.rejectManagedAssistant(resourceType, identity.spaceId, resourceId);
    const resource = await this.loadResource(this.pool, definition, identity.spaceId, resourceId);
    if (!resource || !(await this.canManage(this.pool, identity, resource))) {
      throw new HttpError(404, "Content not found");
    }
    const grants = await this.loadGrants(this.pool, identity.spaceId, resourceType, resourceId);
    return policyOut(resourceType, resource, grants);
  }

  async listAccessLogs(
    identity: SpaceUserIdentity,
    resourceType: string,
    resourceId: string,
    limit: number,
    offset: number,
  ) {
    return new ContentAccessAuditService(this.pool).listForOwner({
      spaceId: identity.spaceId,
      resourceType,
      resourceId,
      ownerUserId: identity.userId,
      limit,
      offset,
    });
  }

  async discloseDemotion(
    identity: SpaceUserIdentity,
    resourceType: string,
    resourceId: string,
    targetVisibility: ContentVisibility,
  ) {
    return new ContentDemotionService(this.pool).disclose(
      identity,
      resourceType,
      resourceId,
      targetVisibility,
    );
  }

  async updatePolicy(
    identity: SpaceUserIdentity,
    resourceType: string,
    resourceId: string,
    update: ContentAccessUpdate,
  ) {
    const definition = requireDefinition(resourceType);
    await this.rejectManagedAssistant(resourceType, identity.spaceId, resourceId);
    validateUpdate(update);
    return withDbTransaction(this.pool, async (client) => {
      const resource = await this.loadResource(client, definition, identity.spaceId, resourceId, true);
      if (!resource || !(await this.canManage(client, identity, resource))) {
        throw new HttpError(404, "Content not found");
      }
      const demoting = narrowsVisibility(resource.visibility, update.visibility);
      if (demoting) {
        if (resource.owner_user_id !== identity.userId) {
          throw new HttpError(403, "Only the resource owner may confirm a demotion");
        }
        await new ContentDemotionService(client).validate(
          client,
          identity,
          resourceType,
          resourceId,
          update.visibility,
          update.demotion_confirmation_id,
        );
      }
      if (update.visibility !== "space_shared" && !resource.owner_user_id) {
        throw new HttpError(422, "owner_user_id is required for private or selected-user content");
      }
      if (update.project_id !== null && update.project_id !== resource.project_id) {
        throw new HttpError(422, "Moving content into another Project requires an explicit filing action");
      }
      if (update.project_id !== null && !definition.projectColumn) {
        throw new HttpError(422, "This content type does not support Project scope");
      }
      const requiredApprovers = taintApprovers(resource.context_taint);
      if (widensVisibility(resource.visibility, update.visibility) && requiredApprovers.length > 0) {
        throw new HttpError(409, "Context-tainted content requires owner approval before publication", {
          code: "context_taint_approval_required",
          required_approver_user_ids: requiredApprovers,
        });
      }

      const grants = dedupeGrants(update.grants, resource.owner_user_id);
      if (update.visibility === "selected_users" && grants.length === 0) {
        throw new HttpError(422, "selected_users visibility requires at least one grantee");
      }
      await this.assertActiveMembers(client, identity.spaceId, grants.map((grant) => grant.user_id));

      const now = new Date().toISOString();
      const scopeUpdates = definition.projectColumn
        ? `, ${definition.projectColumn} = $6${definition.projectFolderColumn && update.project_id === null ? `, ${definition.projectFolderColumn} = NULL` : ""}`
        : "";
      const updateParams: unknown[] = [
        identity.spaceId,
        resourceId,
        update.visibility,
        update.access_level,
        now,
      ];
      if (definition.projectColumn) updateParams.push(update.project_id);
      await client.query(
        `UPDATE ${definition.tableName}
            SET visibility = $3, access_level = $4, updated_at = $5${scopeUpdates}
          WHERE space_id = $1 AND id = $2`,
        updateParams,
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
      if (demoting) {
        await new ContentDemotionService(client).consume(client, update.demotion_confirmation_id!);
      }
      return policyOut(resourceType, updated!, activeGrants);
    });
  }

  async requestPublication(
    identity: SpaceUserIdentity,
    resourceType: string,
    resourceId: string,
    update: ContentAccessUpdate,
  ): Promise<{ proposal_id: string; required_approver_user_ids: string[] }> {
    const definition = requireDefinition(resourceType);
    await this.rejectManagedAssistant(resourceType, identity.spaceId, resourceId);
    if (!definition.publishable || !definition.contextTaintColumn) {
      throw new HttpError(422, "This content type does not support taint-reviewed publication");
    }
    validateUpdate(update);
    if (update.visibility !== "space_shared") {
      throw new HttpError(422, "Publication review requires space_shared visibility");
    }
    return withDbTransaction(this.pool, async (client) => {
      const resource = await this.loadResource(client, definition, identity.spaceId, resourceId, true);
      if (!resource || !(await this.canManage(client, identity, resource))) {
        throw new HttpError(404, "Content not found");
      }
      const requiredApprovers = taintApprovers(resource.context_taint);
      if (requiredApprovers.length === 0) {
        throw new HttpError(422, "Content has no non-instructing owner approval requirement");
      }
      await this.assertActiveMembers(client, identity.spaceId, requiredApprovers);
      const requestedGrants = dedupeGrants(update.grants, resource.owner_user_id);
      await this.assertActiveMembers(client, identity.spaceId, requestedGrants.map((grant) => grant.user_id));
      if (update.project_id !== resource.project_id) {
        throw new HttpError(422, "Publication review cannot move content into another Project");
      }
      const existing = await client.query<{ id: string; payload_json: Record<string, unknown> }>(
        `SELECT id, payload_json FROM proposals
          WHERE space_id = $1 AND proposal_type = 'egress_review' AND status = 'pending'
            AND payload_json->>'target_resource_type' = $2
            AND payload_json->>'target_resource_id' = $3
          ORDER BY created_at DESC LIMIT 1`,
        [identity.spaceId, resourceType, resourceId],
      );
      if (existing.rows[0]) {
        const payload = existing.rows[0].payload_json;
        if (
          payload.requested_visibility !== update.visibility
          || payload.requested_access_level !== update.access_level
          || payload.requested_project_id !== update.project_id
          || JSON.stringify(normalizedGrantList(payload.requested_grants)) !== JSON.stringify(normalizedGrantList(requestedGrants))
        ) {
          throw new HttpError(409, "A different publication request is already pending for this content");
        }
        return { proposal_id: existing.rows[0].id, required_approver_user_ids: requiredApprovers };
      }
      const proposal = await insertProposalRow(client, {
        spaceId: identity.spaceId,
        proposalType: "egress_review",
        title: `Publish ${resourceType}`,
        summary: `Publish ${resourceType} ${resourceId} to the whole Space`,
        payload: {
          proposal_type: "egress_review",
          target_resource_type: resourceType,
          target_resource_id: resourceId,
          requested_visibility: update.visibility,
          requested_access_level: update.access_level,
          requested_project_id: update.project_id,
          requested_grants: requestedGrants,
          requires_approval_type: "egress_content_owner",
          required_egress_approver_user_ids: requiredApprovers,
          context_taint: parseRunContextTaint(resource.context_taint),
        },
        rationale: "Publication requires approval from every non-instructing owner whose content contributed to the output.",
        createdByUserId: identity.userId,
        visibility: "selected_users",
        accessLevel: "full",
        riskLevel: "high",
        requiredApproverRole: "member",
        projectId: resource.project_id,
      });
      const now = new Date().toISOString();
      for (const reviewer of requiredApprovers) {
        await client.query(
          `INSERT INTO content_access_grants (
             id, space_id, resource_type, resource_id, grantee_user_id,
             granted_by_user_id, access_level, created_at, updated_at
           ) VALUES ($1,$2,'proposal',$3,$4,$5,'full',$6,$6)
           ON CONFLICT (space_id, resource_type, resource_id, grantee_user_id)
           DO UPDATE SET revoked_at=NULL, revoked_by_user_id=NULL, updated_at=EXCLUDED.updated_at`,
          [randomUUID(), identity.spaceId, proposal.id, reviewer, identity.userId, now],
        );
      }
      return { proposal_id: proposal.id, required_approver_user_ids: requiredApprovers };
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
    const taintSelect = definition.contextTaintColumn
      ? `${definition.contextTaintColumn}->'context_taint' AS context_taint`
      : "NULL::jsonb AS context_taint";
    const result = await db.query<ResourcePolicyRow>(
      `SELECT id, space_id, ${definition.ownerColumn} AS owner_user_id,
              visibility, access_level, ${projectFolderSelect}, ${projectSelect}, ${taintSelect}
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

  private async rejectManagedAssistant(
    resourceType: string,
    spaceId: string,
    resourceId: string,
  ): Promise<void> {
    if (resourceType !== "agent") return;
    const result = await this.pool.query<{ id: string }>(
      `SELECT id
         FROM agents
        WHERE space_id = $1 AND id = $2 AND agent_kind = 'system_assistant'
        LIMIT 1`,
      [spaceId, resourceId],
    );
    if (result.rows[0]) throw new HttpError(404, "Content not found");
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

function taintApprovers(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const taint = parseRunContextTaint(value);
  if (!taint) throw new HttpError(422, "Content has an invalid context taint summary");
  return taint.non_instructing_owner_user_ids;
}

function widensVisibility(current: string, requested: ContentVisibility): boolean {
  const rank: Record<ContentVisibility, number> = { private: 0, selected_users: 1, space_shared: 2 };
  return isContentVisibility(current) && rank[requested] > rank[current];
}

function narrowsVisibility(current: string, requested: ContentVisibility): boolean {
  const rank: Record<ContentVisibility, number> = { private: 0, selected_users: 1, space_shared: 2 };
  return isContentVisibility(current) && rank[requested] < rank[current];
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
  if (update.project_id !== null && typeof update.project_id !== "string") throw new HttpError(422, "Invalid project_id");
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

function normalizedGrantList(
  value: unknown,
): Array<{ user_id: string; access_level: ContentAccessLevel }> | null {
  if (!Array.isArray(value)) return null;
  const grants: Array<{ user_id: string; access_level: ContentAccessLevel }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.user_id !== "string" || !isContentAccessLevel(row.access_level)) return null;
    grants.push({ user_id: row.user_id, access_level: row.access_level });
  }
  return grants.sort((left, right) => left.user_id.localeCompare(right.user_id)
    || left.access_level.localeCompare(right.access_level));
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
