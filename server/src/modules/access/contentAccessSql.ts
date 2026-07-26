import { projectFolderReadAccessSql } from "../projectFolders/access";
import type { ContentResourceDefinition } from "./contentAccessRegistry";
import { contentResourceDefinition } from "./contentAccessRegistry";
import {
  isContentVisibility,
  type ContentVisibility,
} from "./contentAccessTypes";

export interface ContentAccessSqlOptions {
  /**
   * Whether Space oversight can widen this predicate. Defaults to true for
   * ordinary viewer-facing reads. Pass `false` for queries whose output
   * becomes durable, multi-user-visible content (e.g. project public summary
   * generation) — oversight is a read-only, admin-facing capability and must
   * not let an oversight admin's own private-content visibility leak into
   * space-wide published artifacts (Decision Matrix #4: oversight does not
   * extend to publishing).
   */
  includeOversight?: boolean;
}

export function contentReadSql(
  resourceType: string,
  alias: string,
  userExpr: string,
  options?: ContentAccessSqlOptions,
): string {
  const definition = contentResourceDefinition(resourceType);
  if (!definition) throw new Error(`Unknown content resource type: ${resourceType}`);
  return contentAccessSql({ definition, alias, userExpr, includeOversight: options?.includeOversight });
}

/** Builds non-authoritative visibility filters without duplicating SQL literals. */
export function contentVisibilityFilterSql(
  alias: string,
  visibilities: readonly ContentVisibility[],
): string {
  assertSqlIdentifier(alias, "alias");
  if (visibilities.length === 0 || visibilities.some((value) => !isContentVisibility(value))) {
    throw new Error("Invalid content visibility filter");
  }
  const values = visibilities.map((value) => `'${value}'`).join(", ");
  return visibilities.length === 1
    ? `${alias}.visibility = ${values}`
    : `${alias}.visibility IN (${values})`;
}

export function contentVisibilityParamFilterSql(alias: string, valueExpr: string): string {
  assertSqlIdentifier(alias, "alias");
  if (!/^\$\d+$/.test(valueExpr)) throw new Error("Invalid content visibility parameter");
  return `${alias}.visibility = ${valueExpr}`;
}

/** Builds an owner filter using the registered owner column for the resource. */
export function contentOwnerFilterSql(
  resourceType: string,
  alias: string,
  userExpr: string,
): string {
  assertSqlIdentifier(alias, "alias");
  const definition = contentResourceDefinition(resourceType);
  if (!definition) throw new Error(`Unknown content resource type: ${resourceType}`);
  return `${alias}.${definition.ownerColumn} = ${userExpr}`;
}

export function contentAccessSql(input: {
  definition: ContentResourceDefinition;
  alias: string;
  userExpr: string;
  includeOversight?: boolean;
}): string {
  const { definition, alias, userExpr } = input;
  assertSqlIdentifier(alias, "alias");
  const idExpr = `${alias}.id`;
  const spaceExpr = `${alias}.space_id`;
  const ownerExpr = `${alias}.${definition.ownerColumn}`;
  const scopeSql = contentScopeSql(definition, alias, userExpr);
  const oversightEligibleSql = input.includeOversight === false
    ? "false"
    : contentOversightEligibleSql(spaceExpr, userExpr);

  return `(
    EXISTS (
      SELECT 1
        FROM space_memberships content_member
       WHERE content_member.space_id = ${spaceExpr}
         AND content_member.user_id = ${userExpr}
         AND content_member.status = 'active'
    )
    AND ${scopeSql}
    AND ${alias}.visibility IN ('private', 'space_shared', 'selected_users')
    AND ${alias}.access_level IN ('full', 'summary')
    AND (
      ${ownerExpr} = ${userExpr}
      OR ${alias}.visibility = 'space_shared'
      OR (
        ${alias}.visibility = 'selected_users'
        AND EXISTS (
          SELECT 1
            FROM content_access_grants content_grant
           WHERE content_grant.space_id = ${spaceExpr}
             AND content_grant.resource_type = '${definition.resourceType}'
             AND content_grant.resource_id = ${idExpr}
             AND content_grant.grantee_user_id = ${userExpr}
             AND content_grant.revoked_at IS NULL
        )
      )
      OR ${oversightEligibleSql}
    )
  )`;
}

export function contentAccessLevelSql(input: {
  definition: ContentResourceDefinition;
  alias: string;
  userExpr: string;
  includeOversight?: boolean;
}): string {
  const { definition, alias, userExpr } = input;
  assertSqlIdentifier(alias, "alias");
  const spaceExpr = `${alias}.space_id`;
  const oversightFullSql = input.includeOversight === false
    ? "false"
    : contentOversightLevelAtLeastFullSql(spaceExpr, userExpr);
  const oversightEligibleSql = input.includeOversight === false
    ? "false"
    : contentOversightEligibleSql(spaceExpr, userExpr);
  return `(CASE
    WHEN ${alias}.${definition.ownerColumn} = ${userExpr} THEN 'full'
    WHEN ${alias}.visibility = 'space_shared' THEN
      CASE WHEN ${alias}.access_level = 'full' OR EXISTS (
        SELECT 1 FROM content_access_grants content_level_grant
         WHERE content_level_grant.space_id = ${spaceExpr}
           AND content_level_grant.resource_type = '${definition.resourceType}'
           AND content_level_grant.resource_id = ${alias}.id
           AND content_level_grant.grantee_user_id = ${userExpr}
           AND content_level_grant.access_level = 'full'
           AND content_level_grant.revoked_at IS NULL
      ) OR ${oversightFullSql} THEN 'full'
      ELSE 'summary' END
    WHEN ${alias}.visibility = 'selected_users' THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM content_access_grants content_level_grant
         WHERE content_level_grant.space_id = ${spaceExpr}
           AND content_level_grant.resource_type = '${definition.resourceType}'
           AND content_level_grant.resource_id = ${alias}.id
           AND content_level_grant.grantee_user_id = ${userExpr}
           AND content_level_grant.access_level = 'full'
           AND content_level_grant.revoked_at IS NULL
      ) OR ${oversightFullSql} THEN 'full'
      WHEN EXISTS (
        SELECT 1 FROM content_access_grants content_level_grant
         WHERE content_level_grant.space_id = ${spaceExpr}
           AND content_level_grant.resource_type = '${definition.resourceType}'
           AND content_level_grant.resource_id = ${alias}.id
           AND content_level_grant.grantee_user_id = ${userExpr}
           AND content_level_grant.access_level = 'summary'
           AND content_level_grant.revoked_at IS NULL
      ) OR ${oversightEligibleSql} THEN 'summary'
      ELSE 'summary' END
    WHEN ${oversightFullSql} THEN 'full'
    WHEN ${oversightEligibleSql} THEN 'summary'
    ELSE ${alias}.access_level
  END)`;
}

/** True when the viewer is an active owner/admin of a Space with oversight enabled (any mode). */
function contentOversightEligibleSql(spaceExpr: string, userExpr: string): string {
  return `(
    EXISTS (
      SELECT 1 FROM spaces content_oversight_space
       WHERE content_oversight_space.id = ${spaceExpr}
         AND content_oversight_space.oversight_mode <> 'none'
    )
    AND EXISTS (
      SELECT 1 FROM space_memberships content_oversight_member
       WHERE content_oversight_member.space_id = ${spaceExpr}
         AND content_oversight_member.user_id = ${userExpr}
         AND content_oversight_member.status = 'active'
         AND content_oversight_member.role IN ('owner', 'admin')
    )
  )`;
}

/** True when the viewer's oversight mode for this Space is `content` or `full` (full-level read). */
export function contentOversightLevelAtLeastFullSql(spaceExpr: string, userExpr: string): string {
  return `(
    EXISTS (
      SELECT 1 FROM spaces content_oversight_level_space
       WHERE content_oversight_level_space.id = ${spaceExpr}
         AND content_oversight_level_space.oversight_mode IN ('content', 'full')
    )
    AND EXISTS (
      SELECT 1 FROM space_memberships content_oversight_level_member
       WHERE content_oversight_level_member.space_id = ${spaceExpr}
         AND content_oversight_level_member.user_id = ${userExpr}
         AND content_oversight_level_member.status = 'active'
         AND content_oversight_level_member.role IN ('owner', 'admin')
    )
  )`;
}

/** True only when the viewer's oversight mode is exactly `full`. */
export function contentFullOversightSql(spaceExpr: string, userExpr: string): string {
  return `(
    EXISTS (
      SELECT 1 FROM spaces content_full_oversight_space
       WHERE content_full_oversight_space.id = ${spaceExpr}
         AND content_full_oversight_space.oversight_mode = 'full'
    )
    AND EXISTS (
      SELECT 1 FROM space_memberships content_full_oversight_member
       WHERE content_full_oversight_member.space_id = ${spaceExpr}
         AND content_full_oversight_member.user_id = ${userExpr}
         AND content_full_oversight_member.status = 'active'
         AND content_full_oversight_member.role IN ('owner', 'admin')
    )
  )`;
}

function contentScopeSql(
  definition: ContentResourceDefinition,
  alias: string,
  userExpr: string,
): string {
  const conditions: string[] = [];
  if (definition.projectColumn) {
    const projectExpr = `${alias}.${definition.projectColumn}`;
    conditions.push(`(${projectExpr} IS NULL OR ${projectReadAccessSql(`${alias}.space_id`, projectExpr, userExpr)})`);
  }
  if (definition.projectFolderColumn) {
    const projectFolderExpr = `${alias}.${definition.projectFolderColumn}`;
    conditions.push(`(${projectFolderExpr} IS NULL OR ${projectFolderReadAccessSql({
      spaceExpr: `${alias}.space_id`,
      projectFolderExpr,
      userExpr,
    })})`);
  }
  return conditions.length > 0 ? `(${conditions.join(" AND ")})` : "true";
}

export function projectReadAccessSql(
  spaceExpr: string,
  projectExpr: string,
  userExpr: string,
): string {
  return `EXISTS (
    SELECT 1
      FROM projects content_project
      JOIN spaces content_project_space ON content_project_space.id = content_project.space_id
      LEFT JOIN project_members content_project_member
        ON content_project_member.space_id = content_project.space_id
       AND content_project_member.project_id = content_project.id
       AND content_project_member.user_id = ${userExpr}
       AND content_project_member.status = 'active'
     WHERE content_project.id = ${projectExpr}
       AND content_project.space_id = ${spaceExpr}
       AND content_project.deleted_at IS NULL
       AND (
         content_project_space.type = 'personal'
         OR content_project.owner_user_id = ${userExpr}
         OR content_project_member.user_id IS NOT NULL
       )
  )`;
}

function assertSqlIdentifier(value: string, label: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Invalid content access SQL ${label}`);
  }
}
