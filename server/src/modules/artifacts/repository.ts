import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ReadStream } from "node:fs";
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { Queryable } from "../proposals/repository";
import { contentReadSql } from "../access/contentAccessSql";

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

export interface ArtifactListFilters {
  artifactType?: string | null;
  runId?: string | null;
  projectId?: string | null;
  projectFolderId?: string | null;
  includeSystemArchives?: boolean;
  limit: number;
  offset: number;
}

export interface ArtifactExport {
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
    const built = buildWhere(spaceId, userId, filters);
    const total = await this.db.query<{ total: string | number }>(
      `SELECT count(a.id)::text AS total FROM artifacts a ${built.whereSql}`,
      built.params,
    );
    const limitParam = built.params.length + 1;
    const offsetParam = built.params.length + 2;
    const rows = await this.db.query<ArtifactRow>(
      `${artifactSelectSql()} ${built.whereSql}
        ORDER BY a.created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...built.params, filters.limit, filters.offset],
    );
    return {
      items: rows.rows.map((row) => artifactToOut(row, false)),
      total: numberValue(total.rows[0]?.total) ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async getVisible(
    spaceId: string,
    userId: string,
    artifactId: string,
    includeContent = false,
    _projectFolderId?: string | null,
  ): Promise<ArtifactOut | null> {
    const params: unknown[] = [artifactId, spaceId, userId];
    const result = await this.db.query<ArtifactRow>(
      `${artifactSelectSql()}
        WHERE a.id = $1
          AND a.space_id = $2
          AND ${contentReadSql("artifact", "a", "$3")}`,
      params,
    );
    const row = result.rows[0];
    return row ? artifactToOut(row, includeContent) : null;
  }

  async exportVisible(
    spaceId: string,
    userId: string,
    artifactId: string,
    projectFolderId?: string | null,
  ): Promise<ArtifactExport | null> {
    const artifact = await this.getVisible(spaceId, userId, artifactId, true, projectFolderId);
    if (!artifact) return null;
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
  filters: ArtifactListFilters,
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
  ];
  if (!filters.includeSystemArchives) clauses.push(`a.surface_role <> 'system_archive'`);
  if (filters.artifactType) clauses.push(`a.artifact_type = ${add(filters.artifactType)}`);
  if (filters.runId) clauses.push(`a.run_id = ${add(filters.runId)}`);
  if (filters.projectId) clauses.push(`a.project_id = ${add(filters.projectId)}`);
  if (workspaceParam) clauses.push(`a.project_folder_id = ${workspaceParam}`);
  return { whereSql: `WHERE ${clauses.join(" AND ")}`, params };
}

function artifactSelectSql(): string {
  return `SELECT a.id, a.space_id, a.run_id, a.proposal_id, a.artifact_type, a.surface_role,
                 a.title, a.content, a.storage_ref, a.storage_path, a.mime_type,
                 a.exportable, a.preview, a.metadata_json, a.visibility, a.access_level,
                 a.owner_user_id, a.created_at, a.updated_at, a.project_id, a.project_folder_id
            FROM artifacts a`;
}

function artifactToOut(row: ArtifactRow, includeContent: boolean): ArtifactOut {
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
    content: includeContent ? row.content : null,
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
