import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import type { Queryable } from "../routeUtils/common.js";

export const PROJECT_FILE_DRAFT_MAX_BYTES = 1_048_576;
export const PROJECT_FILE_DRAFT_MAX_TOTAL_BYTES = 50 * 1_048_576;
export const PROJECT_FILE_DRAFT_TTL_DAYS = 90;

export interface ProjectFileDraftRow {
  id: string;
  space_id: string;
  project_id: string;
  project_folder_id: string;
  workspace_location_id: string;
  owner_user_id: string;
  target_kind: "existing" | "new";
  relative_path: string;
  base_exists: boolean;
  base_sha256: string | null;
  content: string;
  content_sha256: string;
  byte_size: number;
  version: number;
  source_encoding: "utf8" | "utf16le" | "utf16be";
  preserve_bom: boolean;
  line_ending_mode: "lf" | "crlf" | "mixed" | "none";
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface ProjectFileDraftMutation {
  id?: string;
  expectedVersion?: number | null;
  targetKind: "existing" | "new";
  relativePath: string;
  baseExists: boolean;
  baseSha256: string | null;
  content: string;
  contentSha256: string;
  byteSize: number;
  sourceEncoding: "utf8" | "utf16le" | "utf16be";
  preserveBom: boolean;
  lineEndingMode: "lf" | "crlf" | "mixed" | "none";
}

export class DraftVersionConflictError extends Error {
  constructor(readonly current: ProjectFileDraftRow | null) {
    super("The draft changed in another tab");
    this.name = "DraftVersionConflictError";
  }
}

export class DraftQuotaError extends Error {
  constructor(readonly usedBytes: number, readonly requestedBytes: number) {
    super("The Project File draft quota is full");
    this.name = "DraftQuotaError";
  }
}

const COLUMNS = `id, space_id, project_id, project_folder_id, workspace_location_id,
  owner_user_id, target_kind, relative_path, base_exists, base_sha256, content,
  content_sha256, byte_size, version, source_encoding, preserve_bom,
  line_ending_mode, created_at, updated_at, expires_at`;

export class PgProjectFileDraftRepository {
  constructor(private readonly db: Queryable) {}

  async get(input: {
    spaceId: string;
    ownerUserId: string;
    projectFolderId: string;
    workspaceLocationId: string;
    relativePath: string;
    targetKind?: "existing" | "new";
  }): Promise<ProjectFileDraftRow | null> {
    const result = await this.db.query<ProjectFileDraftDbRow>(
      `SELECT ${COLUMNS}
         FROM project_file_drafts
        WHERE space_id = $1 AND owner_user_id = $2
          AND project_folder_id = $3 AND workspace_location_id = $4
          AND relative_path = $5
          AND ($6::text IS NULL OR target_kind = $6)
          AND expires_at > NOW()
        LIMIT 1`,
      [input.spaceId, input.ownerUserId, input.projectFolderId, input.workspaceLocationId, input.relativePath, input.targetKind ?? null],
    );
    return result.rows[0] ? rowToDraft(result.rows[0]) : null;
  }

  async getById(input: {
    id: string;
    spaceId: string;
    ownerUserId: string;
    projectFolderId?: string;
  }): Promise<ProjectFileDraftRow | null> {
    const result = await this.db.query<ProjectFileDraftDbRow>(
      `SELECT ${COLUMNS}
         FROM project_file_drafts
        WHERE id = $1 AND space_id = $2 AND owner_user_id = $3
          AND ($4::text IS NULL OR project_folder_id = $4)
          AND expires_at > NOW()
        LIMIT 1`,
      [input.id, input.spaceId, input.ownerUserId, input.projectFolderId ?? null],
    );
    return result.rows[0] ? rowToDraft(result.rows[0]) : null;
  }

  async upsert(input: {
    spaceId: string;
    projectId: string;
    projectFolderId: string;
    workspaceLocationId: string;
    ownerUserId: string;
    mutation: ProjectFileDraftMutation;
  }): Promise<ProjectFileDraftRow> {
    return this.withTransaction(async (db) => {
      await lockDraftQuota(db, input.spaceId, input.ownerUserId);
      await db.query(
        `DELETE FROM project_file_drafts
          WHERE space_id = $1 AND owner_user_id = $2
            AND project_folder_id = $3 AND workspace_location_id = $4
            AND target_kind = $6
            AND ($6 = 'new' OR relative_path = $5)
            AND expires_at <= NOW()`,
        [input.spaceId, input.ownerUserId, input.projectFolderId, input.workspaceLocationId, input.mutation.relativePath, input.mutation.targetKind],
      );
      const existing = await findForUpdate(db, input);
      if (existing && input.mutation.expectedVersion !== undefined
        && (input.mutation.expectedVersion === null || existing.version !== input.mutation.expectedVersion)) {
        throw new DraftVersionConflictError(existing);
      }
      if (!existing && typeof input.mutation.expectedVersion === "number") {
        throw new DraftVersionConflictError(null);
      }
      const used = await usedBytes(db, input.spaceId, input.ownerUserId);
      const nextBytes = used - (existing?.byte_size ?? 0) + input.mutation.byteSize;
      if (nextBytes > PROJECT_FILE_DRAFT_MAX_TOTAL_BYTES) {
        throw new DraftQuotaError(used - (existing?.byte_size ?? 0), input.mutation.byteSize);
      }
      const now = new Date();
      const expires = new Date(now.getTime() + PROJECT_FILE_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
      const id = existing?.id ?? input.mutation.id ?? randomUUID();
      const version = (existing?.version ?? 0) + 1;
      const result = await db.query<ProjectFileDraftDbRow>(
        existing
          ? `UPDATE project_file_drafts SET
               project_id = $2, target_kind = $3, relative_path = $4,
               base_exists = $5, base_sha256 = $6, content = $7,
               content_sha256 = $8, byte_size = $9, version = $10,
               source_encoding = $11, preserve_bom = $12, line_ending_mode = $13,
               updated_at = $14, expires_at = $15
             WHERE id = $1
             RETURNING ${COLUMNS}`
          : `INSERT INTO project_file_drafts (
               id, space_id, project_id, project_folder_id, workspace_location_id,
               owner_user_id, target_kind, relative_path, base_exists, base_sha256,
               content, content_sha256, byte_size, version, source_encoding,
               preserve_bom, line_ending_mode, created_at, updated_at, expires_at
             ) VALUES ($1, $16, $2, $17, $18, $19, $3, $4, $5, $6, $7, $8,
                       $9, $10, $11, $12, $13, $14, $14, $15)
             RETURNING ${COLUMNS}`,
        existing
          ? [id, input.projectId, input.mutation.targetKind, input.mutation.relativePath, input.mutation.baseExists, input.mutation.baseSha256, input.mutation.content, input.mutation.contentSha256, input.mutation.byteSize, version, input.mutation.sourceEncoding, input.mutation.preserveBom, input.mutation.lineEndingMode, now.toISOString(), expires.toISOString()]
          : [id, input.projectId, input.mutation.targetKind, input.mutation.relativePath, input.mutation.baseExists, input.mutation.baseSha256, input.mutation.content, input.mutation.contentSha256, input.mutation.byteSize, version, input.mutation.sourceEncoding, input.mutation.preserveBom, input.mutation.lineEndingMode, now.toISOString(), expires.toISOString(), input.spaceId, input.projectFolderId, input.workspaceLocationId, input.ownerUserId],
      );
      return rowToDraft(result.rows[0]!);
    });
  }

  async discard(input: { id: string; spaceId: string; ownerUserId: string; expectedVersion: number }): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM project_file_drafts
        WHERE id = $1 AND space_id = $2 AND owner_user_id = $3 AND version = $4`,
      [input.id, input.spaceId, input.ownerUserId, input.expectedVersion],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteExact(db: Queryable, input: { id: string; spaceId: string; ownerUserId: string; version: number }): Promise<boolean> {
    const result = await db.query(
      `DELETE FROM project_file_drafts
        WHERE id = $1 AND space_id = $2 AND owner_user_id = $3 AND version = $4`,
      [input.id, input.spaceId, input.ownerUserId, input.version],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteForFolder(db: Queryable, spaceId: string, projectFolderId: string): Promise<number> {
    const result = await db.query(
      `DELETE FROM project_file_drafts WHERE space_id = $1 AND project_folder_id = $2`,
      [spaceId, projectFolderId],
    );
    return result.rowCount ?? 0;
  }

  async quota(spaceId: string, ownerUserId: string): Promise<{ used_bytes: number; limit_bytes: number }> {
    const result = await this.db.query<{ used_bytes: string | number }>(
      `SELECT COALESCE(sum(byte_size), 0)::bigint AS used_bytes
         FROM project_file_drafts
        WHERE space_id = $1 AND owner_user_id = $2 AND expires_at > NOW()`,
      [spaceId, ownerUserId],
    );
    return { used_bytes: Number(result.rows[0]?.used_bytes ?? 0), limit_bytes: PROJECT_FILE_DRAFT_MAX_TOTAL_BYTES };
  }

  async deleteExpired(limit = 500): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM project_file_drafts
        WHERE id IN (
          SELECT id FROM project_file_drafts
           WHERE expires_at <= NOW()
           ORDER BY expires_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )`,
      [limit],
    );
    return result.rowCount ?? 0;
  }

  private async withTransaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    if (isPool(this.db)) return withTransaction(this.db, (client) => fn(client));
    return fn(this.db);
  }
}

async function findForUpdate(db: Queryable, input: {
  spaceId: string;
  ownerUserId: string;
  projectFolderId: string;
  workspaceLocationId: string;
  mutation: ProjectFileDraftMutation;
}): Promise<ProjectFileDraftRow | null> {
  const result = await db.query<ProjectFileDraftDbRow>(
    `SELECT ${COLUMNS}
       FROM project_file_drafts
      WHERE space_id = $1 AND owner_user_id = $2
        AND project_folder_id = $3 AND workspace_location_id = $4
        AND target_kind = $6 AND ($6 = 'new' OR relative_path = $5)
        AND expires_at > NOW()
      FOR UPDATE`,
    [input.spaceId, input.ownerUserId, input.projectFolderId, input.workspaceLocationId, input.mutation.relativePath, input.mutation.targetKind],
  );
  return result.rows[0] ? rowToDraft(result.rows[0]) : null;
}

async function usedBytes(db: Queryable, spaceId: string, ownerUserId: string): Promise<number> {
  const result = await db.query<{ used_bytes: string | number }>(
    `SELECT COALESCE(sum(byte_size), 0)::bigint AS used_bytes
       FROM project_file_drafts
      WHERE space_id = $1 AND owner_user_id = $2 AND expires_at > NOW()`,
    [spaceId, ownerUserId],
  );
  return Number(result.rows[0]?.used_bytes ?? 0);
}

async function lockDraftQuota(db: Queryable, spaceId: string, ownerUserId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`project_file_drafts:${spaceId}:${ownerUserId}`]);
}

function rowToDraft(row: ProjectFileDraftDbRow): ProjectFileDraftRow {
  return {
    ...row,
    target_kind: row.target_kind as ProjectFileDraftRow["target_kind"],
    source_encoding: row.source_encoding as ProjectFileDraftRow["source_encoding"],
    line_ending_mode: row.line_ending_mode as ProjectFileDraftRow["line_ending_mode"],
    byte_size: Number(row.byte_size),
    version: Number(row.version),
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
    expires_at: dateIso(row.expires_at),
  };
}

interface ProjectFileDraftDbRow extends Omit<ProjectFileDraftRow, "byte_size" | "version" | "created_at" | "updated_at" | "expires_at"> {
  byte_size: string | number;
  version: string | number;
  created_at: unknown;
  updated_at: unknown;
  expires_at: unknown;
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function isPool(db: Queryable): db is Pool {
  return typeof (db as Partial<Pool>).connect === "function";
}
