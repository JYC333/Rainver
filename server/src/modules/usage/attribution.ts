import { randomUUID } from "node:crypto";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import {
  isContentAccessLevel,
  isContentVisibility,
  type ContentAccessLevel,
  type ContentVisibility,
} from "../access/contentAccessTypes.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import type { UsageAttribution, UsageGrantSnapshot, UsageObservation } from "./types.js";

interface SourcePolicyRow {
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
  project_folder_id: string | null;
  project_id: string | null;
}

interface SourceGrantRow {
  grantee_user_id: string;
  granted_by_user_id: string;
  access_level: string;
}

export async function resolveUsageAttribution(
  db: Queryable,
  input: UsageObservation,
): Promise<UsageAttribution> {
  const source = sourceReference(input);
  if (source) return sourceAttribution(db, input, source.type, source.id);

  if (input.subject_user_id) {
    await assertActiveMember(db, input.space_id, input.subject_user_id);
    return {
      owner_user_id: input.subject_user_id,
      visibility: "private",
      access_level: "full",
      source_resource_type: null,
      source_resource_id: null,
      project_folder_id: null,
      project_id: null,
      grant_snapshots: [],
    };
  }

  if (input.space_system_task === true && input.meter_subject_type === "space_system") {
    await assertSpaceExists(db, input.space_id);
    return {
      owner_user_id: null,
      visibility: "space_shared",
      access_level: "full",
      source_resource_type: null,
      source_resource_id: null,
      project_folder_id: null,
      project_id: null,
      grant_snapshots: [],
    };
  }

  throw new HttpError(422, "Usage metering requires an owner or an explicit Space system task");
}

function sourceReference(input: UsageObservation): { type: string; id: string } | null {
  const explicitType = nonEmpty(input.source_resource_type);
  const explicitId = nonEmpty(input.source_resource_id);
  if (Boolean(explicitType) !== Boolean(explicitId)) {
    throw new HttpError(422, "Usage source resource type and id must be provided together");
  }
  if (explicitType && explicitId) return { type: explicitType, id: explicitId };
  const runId = nonEmpty(input.run_id);
  if (runId) return { type: "run", id: runId };
  const agentId = nonEmpty(input.agent_id);
  if (agentId) return { type: "agent", id: agentId };
  return null;
}

async function sourceAttribution(
  db: Queryable,
  input: UsageObservation,
  resourceType: string,
  resourceId: string,
): Promise<UsageAttribution> {
  const definition = contentResourceDefinition(resourceType);
  if (!definition || resourceType === "token_usage_event") {
    throw new HttpError(422, `Unsupported usage source resource type '${resourceType}'`);
  }
  const alias = "usage_source";
  const active = definition.activePredicate?.(alias) ?? "true";
  const projectFolderSql = definition.projectFolderColumn
    ? `${alias}.${definition.projectFolderColumn}`
    : "NULL::varchar";
  const projectSql = definition.projectColumn
    ? `${alias}.${definition.projectColumn}`
    : "NULL::varchar";
  const result = await db.query<SourcePolicyRow>(
    `SELECT ${alias}.${definition.ownerColumn} AS owner_user_id,
            ${alias}.visibility,
            ${alias}.access_level,
            ${projectFolderSql} AS project_folder_id,
            ${projectSql} AS project_id
       FROM ${definition.tableName} ${alias}
      WHERE ${alias}.space_id = $1 AND ${alias}.id = $2 AND ${active}
      LIMIT 1`,
    [input.space_id, resourceId],
  );
  const row = result.rows[0];
  if (!row || !isContentVisibility(row.visibility) || !isContentAccessLevel(row.access_level)) {
    throw new HttpError(422, "Usage source resource is unavailable or has invalid access policy");
  }
  if (row.owner_user_id === null && !(input.space_system_task === true && row.visibility === "space_shared")) {
    throw new HttpError(422, "Ownerless usage is allowed only for an explicit Space system task");
  }
  const grants = row.visibility === "selected_users" || row.visibility === "space_shared"
    ? await sourceGrants(db, input.space_id, resourceType, resourceId)
    : [];
  if (row.visibility === "selected_users" && grants.length === 0) {
    throw new HttpError(422, "Selected-user usage source has no active grants");
  }
  return {
    owner_user_id: row.owner_user_id,
    visibility: row.visibility as ContentVisibility,
    access_level: row.access_level as ContentAccessLevel,
    source_resource_type: resourceType,
    source_resource_id: resourceId,
    project_folder_id: row.project_folder_id,
    project_id: row.project_id,
    grant_snapshots: grants,
  };
}

async function sourceGrants(
  db: Queryable,
  spaceId: string,
  resourceType: string,
  resourceId: string,
): Promise<UsageGrantSnapshot[]> {
  const result = await db.query<SourceGrantRow>(
    `SELECT grant_row.grantee_user_id, grant_row.granted_by_user_id, grant_row.access_level
       FROM content_access_grants grant_row
       JOIN space_memberships member
         ON member.space_id = grant_row.space_id
        AND member.user_id = grant_row.grantee_user_id
        AND member.status = 'active'
      WHERE grant_row.space_id = $1
        AND grant_row.resource_type = $2
        AND grant_row.resource_id = $3
        AND grant_row.revoked_at IS NULL
      ORDER BY grant_row.grantee_user_id`,
    [spaceId, resourceType, resourceId],
  );
  const now = new Date().toISOString();
  return result.rows.flatMap((row) => isContentAccessLevel(row.access_level) ? [{
    id: randomUUID(),
    user_id: row.grantee_user_id,
    granted_by_user_id: row.granted_by_user_id,
    access_level: row.access_level,
    created_at: now,
  }] : []);
}

async function assertActiveMember(db: Queryable, spaceId: string, userId: string): Promise<void> {
  const result = await db.query<{ one: number }>(
    `SELECT 1 AS one FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [spaceId, userId],
  );
  if (!result.rows[0]) throw new HttpError(422, "Usage owner must be an active Space member");
}

async function assertSpaceExists(db: Queryable, spaceId: string): Promise<void> {
  const result = await db.query<{ one: number }>(
    `SELECT 1 AS one FROM spaces WHERE id = $1 LIMIT 1`,
    [spaceId],
  );
  if (!result.rows[0]) throw new HttpError(422, "Usage Space does not exist");
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
