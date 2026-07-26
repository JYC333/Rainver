import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import {
  HttpError,
  dateIso,
  optionalString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { getDbPool } from "../../db/pool";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "./access";
import type { ProjectPrimaryMode } from "../projectTemplates/types";
import { projectModeProjectionRegistry } from "./overviewRegistry";

const PRIMARY_MODES: ProjectPrimaryMode[] = ["inquiry", "decision", "delivery", "operations", "learning"];

interface BriefVersionRow {
  id: string;
  space_id: string;
  project_id: string;
  version: string;
  goal: string | null;
  scope_included: string | null;
  scope_excluded: string | null;
  success_definition: string | null;
  constraints: string | null;
  assumptions: string | null;
  created_by_user_id: string | null;
  created_at: unknown;
}

interface ModeTransitionRow {
  id: string;
  space_id: string;
  project_id: string;
  from_mode: string | null;
  to_mode: string;
  reason: string | null;
  trigger_ref: string | null;
  confirmed_by_user_id: string | null;
  created_at: unknown;
}

function briefVersionToOut(row: BriefVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    version: row.version,
    goal: row.goal,
    scope_included: row.scope_included,
    scope_excluded: row.scope_excluded,
    success_definition: row.success_definition,
    constraints: row.constraints,
    assumptions: row.assumptions,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function modeTransitionToOut(row: ModeTransitionRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    from_mode: row.from_mode,
    to_mode: row.to_mode,
    reason: row.reason,
    trigger_ref: row.trigger_ref,
    confirmed_by_user_id: row.confirmed_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Project Brief versioning and Primary Mode transitions. Both are Project
 * Kernel concerns (plan section 5): a Brief Version is a versioned statement
 * of goal/scope/success/constraints/assumptions, and a Mode transition is a
 * focus/projection change only — it never migrates, copies, or deletes any
 * other domain's rows (ADR 0011 / plan section 5.1).
 */
export class ProjectKernelService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): ProjectKernelService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new ProjectKernelService(getDbPool(config.databaseUrl));
  }

  async listBriefVersions(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<BriefVersionRow>(
      `SELECT id, space_id, project_id, version, goal, scope_included, scope_excluded,
              success_definition, constraints, assumptions, created_by_user_id, created_at
         FROM project_brief_versions
        WHERE space_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC`,
      [identity.spaceId, projectId],
    );
    return rows.rows.map(briefVersionToOut);
  }

  async getActiveBriefVersion(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown> | null> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.db.query<BriefVersionRow>(
      `SELECT bv.id, bv.space_id, bv.project_id, bv.version, bv.goal, bv.scope_included, bv.scope_excluded,
              bv.success_definition, bv.constraints, bv.assumptions, bv.created_by_user_id, bv.created_at
         FROM projects p
         JOIN project_brief_versions bv ON bv.id = p.active_brief_version_id AND bv.space_id = p.space_id
        WHERE p.space_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
      [identity.spaceId, projectId],
    );
    return row.rows[0] ? briefVersionToOut(row.rows[0]) : null;
  }

  // Every submitted Brief write creates a new version and moves the active
  // pointer; there is no in-place edit of a published Brief Version (plan
  // section 4.2: "Material changes create a new Brief Version").
  async createBriefVersion(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const count = await db.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM project_brief_versions WHERE space_id = $1 AND project_id = $2`,
        [identity.spaceId, projectId],
      );
      const nextVersion = `v${Number(count.rows[0]?.total ?? "0") + 1}`;
      const briefId = randomUUID();
      const inserted = await db.query<BriefVersionRow>(
        `INSERT INTO project_brief_versions (
           id, space_id, project_id, version, goal, scope_included, scope_excluded,
           success_definition, constraints, assumptions, created_by_user_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, space_id, project_id, version, goal, scope_included, scope_excluded,
                   success_definition, constraints, assumptions, created_by_user_id, created_at`,
        [
          briefId,
          identity.spaceId,
          projectId,
          nextVersion,
          optionalString(body.goal),
          optionalString(body.scope_included),
          optionalString(body.scope_excluded),
          optionalString(body.success_definition),
          optionalString(body.constraints),
          optionalString(body.assumptions),
          identity.userId,
          now,
        ],
      );
      await db.query(
        `UPDATE projects SET active_brief_version_id = $1, updated_at = $2 WHERE id = $3 AND space_id = $4`,
        [briefId, now, projectId, identity.spaceId],
      );
      return briefVersionToOut(inserted.rows[0]!);
    });
  }

  async listModeTransitions(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<ModeTransitionRow>(
      `SELECT id, space_id, project_id, from_mode, to_mode, reason, trigger_ref, confirmed_by_user_id, created_at
         FROM project_mode_transitions
        WHERE space_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC`,
      [identity.spaceId, projectId],
    );
    return rows.rows.map(modeTransitionToOut);
  }

  // A Mode transition writes `projects.primary_mode` and appends its own
  // log. All Project Areas remain reachable regardless of `primary_mode` —
  // this call never hides, converts, or reclassifies domain records, and it
  // intentionally touches no Area-owned business rows. See PROJECTS.md and
  // the Project Model Clean-Cutover plan.
  async transitionMode(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const toMode = requiredMode(body.to_mode);
    if (!projectModeProjectionRegistry.get(toMode)) {
      throw new HttpError(409, `${toMode} Mode is not available until its Overview adapter is registered`);
    }
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const current = await db.query<{ primary_mode: string }>(
        `SELECT primary_mode FROM projects WHERE id = $1 AND space_id = $2`,
        [projectId, identity.spaceId],
      );
      if (!current.rows[0]) throw new HttpError(404, "Project not found");
      const fromMode = current.rows[0].primary_mode;
      const transitionId = randomUUID();
      const inserted = await db.query<ModeTransitionRow>(
        `INSERT INTO project_mode_transitions (
           id, space_id, project_id, from_mode, to_mode, reason, trigger_ref, confirmed_by_user_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, space_id, project_id, from_mode, to_mode, reason, trigger_ref, confirmed_by_user_id, created_at`,
        [
          transitionId,
          identity.spaceId,
          projectId,
          fromMode,
          toMode,
          optionalString(body.reason),
          optionalString(body.trigger_ref),
          identity.userId,
          now,
        ],
      );
      // All installed Project Areas are always reachable, independent of
      // primary_mode — there is no per-Project enabled-Area list to update.
      await db.query(
        `UPDATE projects SET primary_mode = $1::varchar,
           updated_at = $2 WHERE id = $3 AND space_id = $4`,
        [toMode, now, projectId, identity.spaceId],
      );
      return modeTransitionToOut(inserted.rows[0]!);
    });
  }
}

function requiredMode(value: unknown): ProjectPrimaryMode {
  if (typeof value !== "string" || !PRIMARY_MODES.includes(value as ProjectPrimaryMode)) {
    throw new HttpError(422, `to_mode must be one of: ${PRIMARY_MODES.join(", ")}`);
  }
  return value as ProjectPrimaryMode;
}
