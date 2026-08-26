import { projectFolderReadAccessSql } from "../projectFolders/access.js";
import type { ContentProjectShareDeclaration } from "../ontology/entities.js";
import type { ContentResourceDefinition } from "./contentAccessRegistry.js";
import { contentResourceDefinition } from "./contentAccessRegistry.js";
import {
  isContentVisibility,
  type ContentVisibility,
} from "./contentAccessTypes.js";

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
    // The share term is appended only when the resource declares one. An
    // undeclared resource must produce the predicate it produced before this
    // existed — not `OR false`, which would be equivalent but would put a new
    // branch in every plan for every content read in the system.
    const sharedSql = definition.projectShare
      ? ` OR ${projectShareReadAccessSql(definition.projectShare, alias, userExpr)}`
      : "";
    conditions.push(
      `(${projectExpr} IS NULL OR ${projectReadAccessSql(`${alias}.space_id`, projectExpr, userExpr)}${sharedSql})`,
    );
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

/**
 * True when the resource is shared into some Project the viewer can read (U8).
 *
 * This widens the *scope* half of the gate and nothing else: `visibility`,
 * `access_level` and `content_access_grants` are separate conjuncts evaluated
 * after it, so sharing a `private` object into a Project does not make that
 * Project's members able to read it. A share removes the Project barrier; it is
 * not a grant.
 *
 * Its own table/column aliases are distinct from `projectReadAccessSql`'s
 * because the two appear as siblings in the same disjunction.
 */
function projectShareReadAccessSql(
  share: ContentProjectShareDeclaration,
  alias: string,
  userExpr: string,
): string {
  assertSqlIdentifier(share.tableName, "share table");
  assertSqlIdentifier(share.resourceColumn, "share resource column");
  assertSqlIdentifier(share.projectColumn, "share project column");
  assertSqlIdentifier(share.revokedColumn, "share revoked column");
  return `EXISTS (
    SELECT 1
      FROM ${share.tableName} content_share
      JOIN projects content_share_project
        ON content_share_project.id = content_share.${share.projectColumn}
       AND content_share_project.space_id = content_share.space_id
      JOIN spaces content_share_space ON content_share_space.id = content_share_project.space_id
      LEFT JOIN project_members content_share_member
        ON content_share_member.space_id = content_share_project.space_id
       AND content_share_member.project_id = content_share_project.id
       AND content_share_member.user_id = ${userExpr}
       AND content_share_member.status = 'active'
     WHERE content_share.space_id = ${alias}.space_id
       AND content_share.${share.resourceColumn} = ${alias}.id
       AND content_share.${share.revokedColumn} IS NULL
       AND content_share_project.deleted_at IS NULL
       AND (
         content_share_space.type = 'personal'
         OR content_share_project.owner_user_id = ${userExpr}
         OR content_share_member.user_id IS NOT NULL
       )
  )`;
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

/**
 * Room-backed Run outputs remain readable only while the viewer is an active
 * member of that Run's Room. Generic content grants are intentionally not
 * sufficient: a selected-user grant on an artifact or Proposal must not keep
 * a removed Room member's historical output visible.
 */
export function roomRunReadAccessSql(
  runExpr: string,
  spaceExpr: string,
  userExpr: string,
): string {
  const roomIdSql = `COALESCE(room_group.room_id, room_session.room_id)`;
  const roomRunSql = `
    FROM runs room_run
    LEFT JOIN agent_run_groups room_group
      ON room_group.id=room_run.run_group_id AND room_group.space_id=room_run.space_id
    LEFT JOIN sessions room_session
      ON room_session.id=room_run.session_id AND room_session.space_id=room_run.space_id
   WHERE room_run.id=${runExpr}
     AND room_run.space_id=${spaceExpr}
     AND ${roomIdSql} IS NOT NULL`;
  return `(
    NOT EXISTS (SELECT 1 ${roomRunSql})
    OR EXISTS (
      SELECT 1
        FROM runs room_read_run
        LEFT JOIN agent_run_groups room_read_group
          ON room_read_group.id=room_read_run.run_group_id
         AND room_read_group.space_id=room_read_run.space_id
        LEFT JOIN sessions room_read_session
          ON room_read_session.id=room_read_run.session_id
         AND room_read_session.space_id=room_read_run.space_id
        JOIN rooms room_scope
          ON room_scope.id=COALESCE(room_read_group.room_id, room_read_session.room_id)
         AND room_scope.space_id=room_read_run.space_id
        JOIN room_user_members room_member
          ON room_member.room_id=room_scope.id
         AND room_member.space_id=room_scope.space_id
         AND room_member.user_id=${userExpr}
         AND room_member.status='active'
       WHERE room_read_run.id=${runExpr}
         AND room_read_run.space_id=${spaceExpr}
         AND room_scope.status='active'
         AND ${projectReadAccessSql("room_scope.space_id", "room_scope.project_id", userExpr)}
    )
  )`;
}

function assertSqlIdentifier(value: string, label: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Invalid content access SQL ${label}`);
  }
}
