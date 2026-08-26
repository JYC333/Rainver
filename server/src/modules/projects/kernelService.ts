import { randomUUID } from "node:crypto";
import * as protocol from "@agent-space/protocol";
import type { ServerConfig } from "../../config.js";
import {
  HttpError,
  dateIso,
  optionalString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { getDbPool } from "../../db/pool.js";
import { assertProjectOwnerLevel, assertProjectOwnerLevelForMutation, assertProjectReadable, assertProjectWriter, assertProjectWriterForMutation, lockActiveProjectForMutation } from "./access.js";
import { PRIMARY_MODES, isPrimaryMode, type ProjectPrimaryMode } from "./primaryMode.js";
import { projectModeProjectionRegistry } from "./overviewRegistry.js";


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
  project_status: string;
  current_focus: string | null;
  confirmed_decisions_json: unknown;
  primary_mode: string;
  workspace_identity_json: unknown;
  workspace_boundary_json: unknown;
  source_refs_json: unknown;
  status: string;
  reviewed_by_user_id: string | null;
  reviewed_at: unknown;
  published_by_user_id: string | null;
  published_at: unknown;
  created_by_user_id: string | null;
  created_at: unknown;
}

interface InstructionVersionRow {
  id: string; space_id: string; project_id: string; version: string; title: string;
  instruction_text: string; status: string; reviewed_by_user_id: string | null;
  reviewed_at: unknown; published_by_user_id: string | null; published_at: unknown;
  created_by_user_id: string; created_at: unknown;
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
    project_status: row.project_status,
    current_focus: row.current_focus,
    confirmed_decisions: row.confirmed_decisions_json,
    primary_mode: row.primary_mode,
    workspace_identity: row.workspace_identity_json,
    workspace_boundary: row.workspace_boundary_json,
    source_refs: row.source_refs_json,
    status: row.status,
    reviewed_by_user_id: row.reviewed_by_user_id,
    reviewed_at: dateIso(row.reviewed_at),
    published_by_user_id: row.published_by_user_id,
    published_at: dateIso(row.published_at),
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function instructionVersionToOut(row: InstructionVersionRow): Record<string, unknown> {
  return {
    id: row.id, space_id: row.space_id, project_id: row.project_id, version: row.version,
    title: row.title, instruction_text: row.instruction_text, status: row.status,
    reviewed_by_user_id: row.reviewed_by_user_id, reviewed_at: dateIso(row.reviewed_at),
    published_by_user_id: row.published_by_user_id, published_at: dateIso(row.published_at),
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
      `SELECT *
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
      `SELECT bv.*
         FROM projects p
         JOIN project_brief_versions bv ON bv.id = p.active_brief_version_id AND bv.space_id = p.space_id AND bv.status = 'published'
        WHERE p.space_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
      [identity.spaceId, projectId],
    );
    return row.rows[0] ? briefVersionToOut(row.rows[0]) : null;
  }

  // Writes create immutable drafts. Only the explicit owner-level publish
  // transition may move the active pointer.
  async createBriefVersion(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const parsed = protocol.ProjectBriefVersionWriteRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Invalid Project Brief");
    const brief = parsed.data;
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await assertProjectWriterForMutation(db, identity.spaceId, projectId, identity.userId);
      const project = await db.query<{ status: string; current_focus: string | null; primary_mode: string }>(
        `SELECT status, current_focus, primary_mode FROM projects WHERE id=$1 AND space_id=$2`,
        [projectId, identity.spaceId],
      );
      if (!project.rows[0]) throw new HttpError(404, "Project not found");
      const count = await db.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM project_brief_versions WHERE space_id = $1 AND project_id = $2`,
        [identity.spaceId, projectId],
      );
      const nextVersion = `v${Number(count.rows[0]?.total ?? "0") + 1}`;
      const briefId = randomUUID();
      const inserted = await db.query<BriefVersionRow>(
        `INSERT INTO project_brief_versions (
           id, space_id, project_id, version, goal, scope_included, scope_excluded,
           success_definition, constraints, assumptions, project_status, current_focus,
           confirmed_decisions_json, primary_mode, workspace_identity_json,
           workspace_boundary_json, source_refs_json, status, created_by_user_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13::jsonb, $14, $15::jsonb, $16::jsonb, $17::jsonb, 'draft', $18, $19)
         RETURNING *`,
        [
          briefId,
          identity.spaceId,
          projectId,
          nextVersion,
          optionalString(brief.goal),
          optionalString(brief.scope_included),
          optionalString(brief.scope_excluded),
          optionalString(brief.success_definition),
          optionalString(brief.constraints),
          optionalString(brief.assumptions),
          project.rows[0].status,
          project.rows[0].current_focus,
          JSON.stringify(brief.confirmed_decisions ?? []),
          project.rows[0].primary_mode,
          JSON.stringify(brief.workspace_identity ?? {}),
          JSON.stringify(brief.workspace_boundary ?? {}),
          JSON.stringify(brief.source_refs ?? []),
          identity.userId,
          now,
        ],
      );
      return briefVersionToOut(inserted.rows[0]!);
    });
  }

  async submitBriefForReview(identity: SpaceUserIdentity, projectId: string, versionId: string): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return briefVersionToOut(await this.transitionBrief(projectId, identity.spaceId, versionId, "draft", "in_review", identity.userId, false));
  }

  async publishBrief(identity: SpaceUserIdentity, projectId: string, versionId: string): Promise<Record<string, unknown>> {
    await assertProjectOwnerLevel(this.db, identity.spaceId, projectId, identity.userId);
    return briefVersionToOut(await this.transitionBrief(projectId, identity.spaceId, versionId, "in_review", "published", identity.userId, true));
  }

  private async transitionBrief(projectId: string, spaceId: string, versionId: string, from: string, to: string, userId: string, activate: boolean): Promise<BriefVersionRow> {
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, spaceId, projectId);
      if (activate) await assertProjectOwnerLevelForMutation(db, spaceId, projectId, userId);
      else await assertProjectWriterForMutation(db, spaceId, projectId, userId);
      if (activate) await assertNewerProjectContextVersion(db, "project_brief_versions", projectId, spaceId, versionId, "Brief");
      if (activate) await db.query(`UPDATE project_brief_versions SET status='archived' WHERE project_id=$1 AND space_id=$2 AND status='published'`, [projectId, spaceId]);
      const result = await db.query<BriefVersionRow>(
        `UPDATE project_brief_versions SET status=$1::varchar,
           reviewed_by_user_id=CASE WHEN $1::varchar='published' THEN $2::varchar ELSE reviewed_by_user_id END,
           reviewed_at=CASE WHEN $1::varchar='published' THEN $3::timestamptz ELSE reviewed_at END,
           published_by_user_id=CASE WHEN $1::varchar='published' THEN $2::varchar ELSE published_by_user_id END,
           published_at=CASE WHEN $1::varchar='published' THEN $3::timestamptz ELSE published_at END
         WHERE id=$4 AND project_id=$5 AND space_id=$6 AND status=$7
         RETURNING *`, [to, userId, now, versionId, projectId, spaceId, from]);
      if (!result.rows[0]) throw new HttpError(409, `Brief version must be ${from}`);
      if (activate) await db.query(`UPDATE projects SET active_brief_version_id=$1, updated_at=$2 WHERE id=$3 AND space_id=$4`, [versionId, now, projectId, spaceId]);
      return result.rows[0];
    });
  }

  async listInstructionVersions(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<InstructionVersionRow>(`SELECT * FROM project_instruction_versions WHERE space_id=$1 AND project_id=$2 ORDER BY created_at DESC`, [identity.spaceId, projectId]);
    return rows.rows.map(instructionVersionToOut);
  }

  async getActiveInstructionVersion(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown> | null> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.db.query<InstructionVersionRow>(`SELECT iv.* FROM projects p JOIN project_instruction_versions iv ON iv.id=p.active_instruction_version_id AND iv.status='published' WHERE p.space_id=$1 AND p.id=$2 AND p.deleted_at IS NULL`, [identity.spaceId, projectId]);
    return row.rows[0] ? instructionVersionToOut(row.rows[0]) : null;
  }

  async createInstructionVersion(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectOwnerLevel(this.db, identity.spaceId, projectId, identity.userId);
    const parsed = protocol.ProjectInstructionVersionWriteRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Invalid Project Instruction");
    const { title, instruction_text: instruction } = parsed.data;
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await assertProjectOwnerLevelForMutation(db, identity.spaceId, projectId, identity.userId);
      const count = await db.query<{ total: string }>(`SELECT count(*)::text total FROM project_instruction_versions WHERE project_id=$1 AND space_id=$2`, [projectId, identity.spaceId]);
      const result = await db.query<InstructionVersionRow>(`INSERT INTO project_instruction_versions (id,space_id,project_id,version,title,instruction_text,status,created_by_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8) RETURNING *`, [randomUUID(), identity.spaceId, projectId, `v${Number(count.rows[0]?.total ?? 0) + 1}`, title, instruction, identity.userId, new Date().toISOString()]);
      return instructionVersionToOut(result.rows[0]!);
    });
  }

  async transitionInstruction(identity: SpaceUserIdentity, projectId: string, versionId: string, publish: boolean): Promise<Record<string, unknown>> {
    await assertProjectOwnerLevel(this.db, identity.spaceId, projectId, identity.userId);
    const from = publish ? "in_review" : "draft"; const to = publish ? "published" : "in_review"; const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await assertProjectOwnerLevelForMutation(db, identity.spaceId, projectId, identity.userId);
      if (publish) await assertNewerProjectContextVersion(db, "project_instruction_versions", projectId, identity.spaceId, versionId, "Instruction");
      if (publish) await db.query(`UPDATE project_instruction_versions SET status='archived' WHERE project_id=$1 AND space_id=$2 AND status='published'`, [projectId, identity.spaceId]);
      const result = await db.query<InstructionVersionRow>(`UPDATE project_instruction_versions SET status=$1::varchar, reviewed_by_user_id=CASE WHEN $1::varchar='published' THEN $2::varchar ELSE reviewed_by_user_id END, reviewed_at=CASE WHEN $1::varchar='published' THEN $3::timestamptz ELSE reviewed_at END, published_by_user_id=CASE WHEN $1::varchar='published' THEN $2::varchar ELSE published_by_user_id END, published_at=CASE WHEN $1::varchar='published' THEN $3::timestamptz ELSE published_at END WHERE id=$4 AND project_id=$5 AND space_id=$6 AND status=$7 RETURNING *`, [to, identity.userId, now, versionId, projectId, identity.spaceId, from]);
      if (!result.rows[0]) throw new HttpError(409, `Instruction version must be ${from}`);
      if (publish) await db.query(`UPDATE projects SET active_instruction_version_id=$1, updated_at=$2 WHERE id=$3 AND space_id=$4`, [versionId, now, projectId, identity.spaceId]);
      return instructionVersionToOut(result.rows[0]);
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

async function assertNewerProjectContextVersion(
  db: Queryable,
  table: "project_brief_versions" | "project_instruction_versions",
  projectId: string,
  spaceId: string,
  candidateId: string,
  label: string,
): Promise<void> {
  const result = await db.query<{ candidate_version: string; active_version: string | null }>(
    `SELECT candidate.version AS candidate_version, active.version AS active_version
       FROM ${table} candidate
       LEFT JOIN ${table} active
         ON active.project_id=candidate.project_id
        AND active.space_id=candidate.space_id
        AND active.status='published'
      WHERE candidate.id=$1 AND candidate.project_id=$2 AND candidate.space_id=$3`,
    [candidateId, projectId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, `${label} version not found`);
  if (row.active_version && versionOrdinal(row.candidate_version) <= versionOrdinal(row.active_version)) {
    throw new HttpError(409, `Cannot publish a stale ${label} version; use an explicit rollback flow`);
  }
}

function versionOrdinal(value: string): number {
  const match = /^v([1-9][0-9]*)$/.exec(value);
  if (!match) throw new HttpError(409, `Invalid Project context version: ${value}`);
  return Number(match[1]);
}

function requiredMode(value: unknown): ProjectPrimaryMode {
  if (!isPrimaryMode(value)) {
    throw new HttpError(422, `to_mode must be one of: ${PRIMARY_MODES.join(", ")}`);
  }
  return value as ProjectPrimaryMode;
}
