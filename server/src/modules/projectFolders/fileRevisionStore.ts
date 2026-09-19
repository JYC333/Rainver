import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import type { Queryable } from "../routeUtils/common.js";

export interface ProjectFileRevisionOut {
  id: string;
  project_folder_id: string;
  workspace_location_id: string;
  path: string;
  before_exists: boolean;
  after_exists: boolean;
  after_sha256: string | null;
  created_at: string;
  expires_at: string;
  status: string;
}

export interface ProjectFileRevision extends ProjectFileRevisionOut {
  space_id: string;
  project_id: string;
  before_content: string | null;
}

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_COUNT = 20;

export class PgProjectFileRevisionStore {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    spaceId: string;
    projectId: string;
    projectFolderId: string;
    workspaceLocationId: string;
    path: string;
    beforeExists: boolean;
    beforeContent: string | null;
    afterExists: boolean;
    afterSha256: string | null;
    userId: string;
    retentionDays?: number | null;
    maxCount?: number | null;
  }): Promise<ProjectFileRevisionOut> {
    const write = (db: Queryable): Promise<ProjectFileRevisionOut> => this.createInTransaction(db, input);
    return isPool(this.db) ? withTransaction(this.db, write) : write(this.db);
  }

  /** Create a revision inside a caller-owned transaction (for draft save). */
  async createInTransaction(db: Queryable, input: {
    spaceId: string;
    projectId: string;
    projectFolderId: string;
    workspaceLocationId: string;
    path: string;
    beforeExists: boolean;
    beforeContent: string | null;
    afterExists: boolean;
    afterSha256: string | null;
    userId: string;
    retentionDays?: number | null;
    maxCount?: number | null;
  }): Promise<ProjectFileRevisionOut> {
      const id = randomUUID();
      const now = new Date();
      const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
      const expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
      const result = await db.query<ProjectFileRevisionRow>(
        `INSERT INTO project_file_revisions (
           id, space_id, project_id, project_folder_id, workspace_location_id, path,
           before_exists, before_content, after_exists, after_sha256,
           created_by_user_id, created_at, expires_at, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'available')
         RETURNING ${COLUMNS}`,
        [
          id, input.spaceId, input.projectId, input.projectFolderId, input.workspaceLocationId, input.path,
          input.beforeExists, input.beforeContent, input.afterExists, input.afterSha256,
          input.userId, now.toISOString(), expiresAt.toISOString(),
        ],
      );
      const maxCount = input.maxCount ?? DEFAULT_MAX_COUNT;
      await db.query(
        `UPDATE project_file_revisions
            SET status = 'pruned'
          WHERE project_folder_id = $1
            AND status = 'available'
            AND id NOT IN (
              SELECT id FROM project_file_revisions
               WHERE project_folder_id = $1 AND status = 'available'
               ORDER BY created_at DESC, id DESC
               LIMIT $2
            )`,
        [input.projectFolderId, maxCount],
      );
      return revisionToOut(result.rows[0]!);
  }

  async listForFile(spaceId: string, projectId: string, folderId: string, workspaceLocationId: string, path: string): Promise<ProjectFileRevisionOut[]> {
    const result = await this.db.query<ProjectFileRevisionRow>(
      `SELECT ${COLUMNS}
         FROM project_file_revisions
        WHERE space_id = $1 AND project_id = $2 AND project_folder_id = $3
          AND workspace_location_id = $4 AND path = $5
          AND status = 'available' AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 20`,
      [spaceId, projectId, folderId, workspaceLocationId, path],
    );
    return result.rows.map(revisionToOut);
  }

  async getAvailable(spaceId: string, projectId: string, folderId: string, id: string): Promise<ProjectFileRevision | null> {
    const result = await this.db.query<ProjectFileRevisionRow>(
      `SELECT ${COLUMNS}
         FROM project_file_revisions
        WHERE id = $1 AND space_id = $2 AND project_id = $3 AND project_folder_id = $4
          AND status = 'available' AND expires_at > NOW()
        LIMIT 1`,
      [id, spaceId, projectId, folderId],
    );
    const row = result.rows[0];
    return row ? {
      ...revisionToOut(row),
      space_id: row.space_id,
      project_id: row.project_id,
      before_content: row.before_content,
    } : null;
  }

}

interface ProjectFileRevisionRow {
  id: string;
  space_id: string;
  project_id: string;
  project_folder_id: string;
  workspace_location_id: string;
  path: string;
  before_exists: boolean;
  before_content: string | null;
  after_exists: boolean;
  after_sha256: string | null;
  created_at: unknown;
  expires_at: unknown;
  status: string;
}

const COLUMNS = `id, space_id, project_id, project_folder_id, workspace_location_id, path,
  before_exists, before_content, after_exists, after_sha256,
  created_at, expires_at, status`;

function revisionToOut(row: ProjectFileRevisionRow): ProjectFileRevisionOut {
  return {
    id: row.id,
    project_folder_id: row.project_folder_id,
    workspace_location_id: row.workspace_location_id,
    path: row.path,
    before_exists: row.before_exists,
    after_exists: row.after_exists,
    after_sha256: row.after_sha256,
    created_at: dateIso(row.created_at),
    expires_at: dateIso(row.expires_at),
    status: row.status,
  };
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function isPool(db: Queryable): db is Pool {
  return typeof (db as Partial<Pool>).connect === "function";
}
