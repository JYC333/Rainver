import {assertResearchArtifactReadable} from '../projectResearch/reportAccess.js';
import {ResearchCallContentUnavailable} from '../projectResearch/researchCallAccess.js';
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ReadStream } from "node:fs";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../proposals/repository.js";
import { contentAccessLevelSql, contentReadSql, roomRunReadAccessSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { bodyWithheld, type WithAccessLevel } from "../access/contentAccessTypes.js";
import { recordDetailRead } from "../contentAccess/audit.js";
import { sourceDerivedArtifactReadableClause } from "../sources/sourceItemAccess.js";
import { retrievalArtifactWithheld, withheldArtifactTitle } from "../retrieval/artifactRelease.js";

const ARTIFACT_ACCESS = contentResourceDefinition("artifact")!;

export interface ArtifactOut {
  id: string;
  space_id: string;
  run_id: string | null;
  proposal_id: string | null;
  artifact_type: string;
  surface_role: "user_output" | "operational" | "system_archive";
  title: string;
  mime_type: string | null;
  exportable: boolean;
  preview: boolean;
  storage_ref: string | null;
  storage_path: string | null;
  metadata_json: Record<string, unknown> | null;
  has_inline_content: boolean;
  visibility: string;
  access_level: string;
  owner_user_id: string | null;
  content: string | null;
  created_at: string;
  updated_at: string;
  project_id: string | null;
  project_folder_id: string | null;
}

export interface ArtifactPage {
  items: ArtifactOut[];
  total: number;
  limit: number;
  offset: number;
}

interface ArtifactRow {
  id: string;
  space_id: string;
  run_id: string | null;
  proposal_id: string | null;
  artifact_type: string;
  surface_role: "user_output" | "operational" | "system_archive";
  title: string;
  content: string | null;
  storage_ref: string | null;
  storage_path: string | null;
  mime_type: string | null;
  exportable: boolean;
  preview: boolean;
  metadata_json: Record<string, unknown> | null;
  visibility: string;
  access_level: string;
  owner_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
  project_id: string | null;
  project_folder_id: string | null;
}

interface ArtifactFilters {
  artifactType?: string | null;
  runId?: string | null;
  projectId?: string | null;
  projectFolderId?: string | null;
  includeSystemArchives?: boolean;
}

interface ArtifactListFilters extends ArtifactFilters {
  limit: number;
  offset: number;
}

interface ArtifactExport {
  artifact: ArtifactOut;
  filename: string;
  mediaType: string;
  body?: Buffer;
  stream?: ReadStream;
}

export class PgArtifactRepository {
  constructor(
    private readonly db: Queryable,
    private readonly config: Pick<ServerConfig, "artifactStorageRoot" | "sandboxRoot">,
  ) {}

  static fromConfig(config: ServerConfig): PgArtifactRepository {
    if (!config.databaseUrl) {
      throw new Error("Artifact repository requires SERVER_DATABASE_URL");
    }
    return new PgArtifactRepository(getDbPool(config.databaseUrl), config);
  }

  async listVisible(
    spaceId: string,
    userId: string,
    filters: ArtifactListFilters,
  ): Promise<ArtifactPage> {
    if (filters.projectId) {
      const project = await this.db.query(
        `SELECT id FROM projects WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
        [filters.projectId, spaceId],
      );
      if ((project.rowCount ?? 0) === 0) throw new ArtifactValidationError("Project not found");
    }
    if (filters.projectFolderId) {
      const folder = await this.db.query(
        `SELECT id FROM project_folders WHERE id = $1 AND space_id = $2`,
        [filters.projectFolderId, spaceId],
      );
      if ((folder.rowCount ?? 0) === 0) throw new ArtifactValidationError("Project Folder not found");
    }
    // The read rules expand to several hundred sub-selects; planning one such
    // statement costs over a hundred milliseconds. When the filters select no
    // row at all, no rule can make one readable, so an indexed probe answers
    // the common empty page (a Run without Artifacts) without planning them.
    const candidates = candidateWhere(spaceId, filters);
    const candidate = await this.db.query(`SELECT 1 FROM artifacts a ${candidates.whereSql} LIMIT 1`, candidates.params);
    if ((candidate.rowCount ?? 0) === 0) return { items: [], total: 0, limit: filters.limit, offset: filters.offset };
    // Count and page come from one statement, so both see one snapshot: a
    // concurrent write cannot make `total` disagree with the page, and a page
    // past the end still reports the visible total. The read rules are
    // evaluated once, into `visible`; the access level only for the page's
    // rows. Equal timestamps order by id, so offsets neither repeat nor skip.
    const built = buildWhere(spaceId, userId, filters);
    const limitParam = built.params.length + 1;
    const offsetParam = built.params.length + 2;
    const result = await this.db.query<{ total: string } & Partial<WithAccessLevel<ArtifactRow>>>(
      `WITH visible AS MATERIALIZED (
         SELECT a.id, a.created_at FROM artifacts a ${built.whereSql}
       ),
       page AS (
         SELECT id FROM visible ORDER BY created_at DESC, id DESC
          LIMIT $${limitParam} OFFSET $${offsetParam}
       )
       SELECT t.total, r.*
         FROM (SELECT count(*)::text AS total FROM visible) t
         LEFT JOIN LATERAL (
           ${artifactSelectSql("$2")} JOIN page p ON p.id = a.id
         ) r ON true
        ORDER BY r.created_at DESC, r.id DESC`,
      [...built.params, filters.limit, filters.offset],
    );
    const rows = result.rows.filter((row) => row.id != null) as Array<WithAccessLevel<ArtifactRow>>;
    return {
      items: await Promise.all(rows.map(async row=>artifactToOut(await this.gateResearchOrigin(spaceId,userId,row,"artifact list read"),false))),
      total: numberValue(result.rows[0]?.total) ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async listVisibleForRun(spaceId: string, userId: string, runId: string): Promise<ArtifactOut[]> {
    const filters = { runId, includeSystemArchives: true };
    const candidates = candidateWhere(spaceId, filters);
    const candidate = await this.db.query(`SELECT 1 FROM artifacts a ${candidates.whereSql} LIMIT 1`, candidates.params);
    if ((candidate.rowCount ?? 0) === 0) return [];

    const built = buildWhere(spaceId, userId, filters);
    const { rows } = await this.db.query<WithAccessLevel<ArtifactRow>>(
      `${artifactSelectSql("$2")} ${built.whereSql} ORDER BY a.created_at ASC, a.id ASC`,
      built.params,
    );
    return Promise.all(rows.map(async (row) =>
      artifactToOut(await this.gateResearchOrigin(spaceId, userId, row, "artifact list read"), false)));
  }

  async getVisible(
    spaceId: string,
    userId: string,
    artifactId: string,
    includeContent = false,
    _projectFolderId?: string | null,
  ): Promise<ArtifactOut | null> {
    const row = await this.loadVisibleRow(spaceId, userId, artifactId);
    if (!row) return null;
    await recordDetailRead(this.db, {
      spaceId,
      viewerUserId: userId,
      resourceType: "artifact",
      resourceId: artifactId,
    });
    return artifactToOut(row, includeContent);
  }

  async exportVisible(
    spaceId: string,
    userId: string,
    artifactId: string,
    projectFolderId?: string | null,
  ): Promise<ArtifactExport | null> {
    const row = await this.loadVisibleRow(spaceId, userId, artifactId);
    if (!row || bodyWithheld(row.effective_access_level)) return null;
    await recordDetailRead(this.db, {
      spaceId,
      viewerUserId: userId,
      resourceType: "artifact",
      resourceId: artifactId,
    });
    const artifact = artifactToOut(row, true);
    const filename = exportFilename(artifact.title);
    const mediaType = artifact.mime_type ?? "application/octet-stream";
    if (artifact.content) {
      return {
        artifact,
        filename,
        mediaType,
        body: Buffer.from(artifact.content, "utf8"),
      };
    }
    const path = await this.resolveStoredFile(artifact.storage_path);
    if (!path) throw new ArtifactNotExportableError("Artifact has no inline content and no valid storage file");
    return {
      artifact,
      filename,
      mediaType,
      stream: createReadStream(path),
    };
  }

  private async resolveStoredFile(storagePath: string | null): Promise<string | null> {
    if (!storagePath) return null;
    if (storagePath.startsWith("/") || storagePath.includes("\0")) return null;
    const root = resolve(this.config.artifactStorageRoot);
    const sandboxRoot = resolve(this.config.sandboxRoot);
    const candidate = resolve(root, storagePath);
    if (!isInside(candidate, root)) return null;
    if (isInside(candidate, sandboxRoot)) return null;
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) return null;
    return candidate;
  }

  private async loadVisibleRow(
    spaceId: string,
    userId: string,
    artifactId: string,
  ): Promise<WithAccessLevel<ArtifactRow> | null> {
    const row = await loadDetailRow(this.db, spaceId, userId, artifactId);
    return row?this.gateResearchOrigin(spaceId,userId,row,"artifact detail read"):null;
  }
  private async gateResearchOrigin(spaceId:string,userId:string,row:WithAccessLevel<ArtifactRow>,auditReason:string):Promise<WithAccessLevel<ArtifactRow>>{
    const withheld=await originWithholding(this.db,spaceId,userId,row,auditReason);
    if(withheld==="research")return {...row,title:"Research report artifact",content:null,metadata_json:null,storage_ref:null,storage_path:null,mime_type:null,owner_user_id:null,run_id:null,proposal_id:null,project_folder_id:null,exportable:false,preview:false,access_level:"summary",effective_access_level:"summary"};
    if(withheld==="retrieval")return {...row,title:withheldArtifactTitle(row.artifact_type,row.title),content:null,metadata_json:null,storage_ref:null,storage_path:null,exportable:false,preview:false,access_level:"summary",effective_access_level:"summary"};
    return row;
  }
}

/** The detail reader's row gate: content ACL, the producing Run's Room and
 * the Source-derived gate (`sourceDerivedArtifactReadableClause`). */
async function loadDetailRow(db: Queryable, spaceId: string, userId: string, artifactId: string): Promise<WithAccessLevel<ArtifactRow> | null> {
  const result = await db.query<WithAccessLevel<ArtifactRow>>(
    `${artifactSelectSql("$3")}
      WHERE a.id = $1
        AND a.space_id = $2
        AND ${contentReadSql("artifact", "a", "$3")}
        AND ${roomRunReadAccessSql("a.run_id", "a.space_id", "$3")}
        AND ${sourceDerivedArtifactReadableClause("a", "$3")}`,
    [artifactId, spaceId, userId],
  );
  return result.rows[0] ?? null;
}

/** Which origin gate withholds a readable row's own fields (title included):
 * a research-call output whose chain is no longer readable, or a Brief /
 * Explain / persisted report whose contributing refs no longer pass the
 * canonical release gate. A Brief/Explain body and metadata (answer,
 * citations, gaps, target) and a persisted report's findings, counts and
 * count-bearing title are derived from other objects: list, detail and export
 * release them only while every contributing ref passes that gate. */
async function originWithholding(db: Queryable, spaceId: string, userId: string, row: ArtifactRow, auditReason: string | null): Promise<"research" | "retrieval" | null> {
  try{await assertResearchArtifactReadable(db,{spaceId,userId},row.id);}catch(error){if(!(error instanceof ResearchCallContentUnavailable))throw error;return "research";}
  return await retrievalArtifactWithheld(db,{spaceId,userId},row,auditReason) ? "retrieval" : null;
}

/**
 * Whether the Artifact detail reader would show this person the Artifact's
 * own title now: the same row gate (content ACL, Run Room, Source-derived
 * gate) and origin gates (research call, retrieval/report release) as
 * `getVisible`, recording no read. A summary-level Artifact's title is
 * released, as on its detail page; a withheld or unreadable one is not.
 */
export async function artifactTitleReleased(db: Queryable, identity: { spaceId: string; userId: string }, artifactId: string): Promise<boolean> {
  const row = await loadDetailRow(db, identity.spaceId, identity.userId, artifactId);
  return Boolean(row) && await originWithholding(db, identity.spaceId, identity.userId, row!, null) === null;
}

/**
 * The Artifact's inline body as the detail reader would release it to this
 * person now — the same row gate and origin gates (research call with its
 * recursive `input_refs`, retrieval/report release) as `getVisible`, at
 * `full` level — or null when that reader would withhold it. Records no read;
 * a caller that must hold the decision to its response holds
 * `lockArtifactReleaseClosure` first.
 */
export async function artifactBodyReleased(db: Queryable, identity: { spaceId: string; userId: string }, artifactId: string): Promise<string | null> {
  const row = await loadDetailRow(db, identity.spaceId, identity.userId, artifactId);
  if (!row || bodyWithheld(row.effective_access_level)) return null;
  return await originWithholding(db, identity.spaceId, identity.userId, row, null) === null ? row.content : null;
}

export class ArtifactValidationError extends Error {
  readonly statusCode = 422;
}

export class ArtifactNotExportableError extends Error {
  readonly statusCode = 404;
}

function buildWhere(
  spaceId: string,
  userId: string,
  filters: ArtifactFilters,
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [spaceId, userId];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const workspaceParam = filters.projectFolderId ? add(filters.projectFolderId) : null;
  const clauses = [
    `a.space_id = $1`,
    contentReadSql("artifact", "a", "$2"),
    roomRunReadAccessSql("a.run_id", "a.space_id", "$2"),
    sourceDerivedArtifactReadableClause("a", "$2"),
  ];
  if (!filters.includeSystemArchives) clauses.push(`a.surface_role <> 'system_archive'`);
  if (filters.artifactType) clauses.push(`a.artifact_type = ${add(filters.artifactType)}`);
  if (filters.runId) clauses.push(`a.run_id = ${add(filters.runId)}`);
  if (filters.projectId) clauses.push(`a.project_id = ${add(filters.projectId)}`);
  if (workspaceParam) clauses.push(`a.project_folder_id = ${workspaceParam}`);
  return { whereSql: `WHERE ${clauses.join(" AND ")}`, params };
}

/**
 * The rows `buildWhere`'s filters select before any read rule. It may only
 * prove that nothing exists to read (the read rules can only remove rows),
 * never that something is readable.
 */
function candidateWhere(
  spaceId: string,
  filters: ArtifactFilters,
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [spaceId];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const clauses = [`a.space_id = $1`];
  if (!filters.includeSystemArchives) clauses.push(`a.surface_role <> 'system_archive'`);
  if (filters.artifactType) clauses.push(`a.artifact_type = ${add(filters.artifactType)}`);
  if (filters.runId) clauses.push(`a.run_id = ${add(filters.runId)}`);
  if (filters.projectId) clauses.push(`a.project_id = ${add(filters.projectId)}`);
  if (filters.projectFolderId) clauses.push(`a.project_folder_id = ${add(filters.projectFolderId)}`);
  return { whereSql: `WHERE ${clauses.join(" AND ")}`, params };
}

function artifactSelectSql(userExpr: string): string {
  return `SELECT a.id, a.space_id, a.run_id, a.proposal_id, a.artifact_type, a.surface_role,
                 a.title, a.content, a.storage_ref, a.storage_path, a.mime_type,
                 a.exportable, a.preview, a.metadata_json, a.visibility, a.access_level,
                 a.owner_user_id, a.created_at, a.updated_at, a.project_id, a.project_folder_id,
                 CASE WHEN ${contentAccessLevelSql({ definition: ARTIFACT_ACCESS, alias: "a", userExpr })} = 'full'
                        AND ${sourceDerivedArtifactReadableClause("a", userExpr, true)}
                      THEN 'full' ELSE 'summary' END AS effective_access_level
            FROM artifacts a`;
}

function artifactToOut(row: WithAccessLevel<ArtifactRow>, includeContent: boolean): ArtifactOut {
  return {
    id: row.id,
    space_id: row.space_id,
    run_id: row.run_id,
    proposal_id: row.proposal_id,
    artifact_type: row.artifact_type,
    surface_role: row.surface_role,
    title: row.title,
    mime_type: row.mime_type,
    exportable: Boolean(row.exportable),
    preview: Boolean(row.preview),
    storage_ref: row.storage_ref,
    storage_path: row.storage_path,
    metadata_json: row.metadata_json,
    has_inline_content: Boolean(row.content),
    visibility: row.visibility,
    access_level: row.access_level,
    owner_user_id: row.owner_user_id,
    content: includeContent && !bodyWithheld(row.effective_access_level) ? row.content : null,
    created_at: dateValue(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateValue(row.updated_at) ?? new Date(0).toISOString(),
    project_id: row.project_id,
    project_folder_id: row.project_folder_id,
  };
}

function exportFilename(title: string): string {
  const safe = title.trim().replace(/[^\w.-]+/g, "_").slice(0, 200);
  return basename(safe || "artifact");
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dateValue(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}
