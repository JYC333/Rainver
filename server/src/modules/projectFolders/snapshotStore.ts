import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

export const SNAPSHOT_DEFAULT_RETENTION_DAYS = 7;
export const SNAPSHOT_DEFAULT_MAX_COUNT = 20;

export interface SnapshotFile {
  path: string;
  existed: boolean;
  content: string | null;
}

interface SnapshotRow {
  id: string;
  proposal_id: string;
  space_id: string;
  project_folder_id: string;
  files_json: SnapshotFile[] | null;
  created_at: unknown;
  expires_at: unknown;
  status: string;
  rolled_back_by_user_id: string | null;
  rolled_back_at: unknown;
}

export interface CodePatchSnapshotOut {
  id: string;
  proposal_id: string;
  space_id: string;
  project_folder_id: string;
  files: SnapshotFile[];
  created_at: string;
  expires_at: string;
  status: string;
  rolled_back_by_user_id: string | null;
  rolled_back_at: string | null;
}

export class PgSnapshotStore {
  constructor(private readonly db: Queryable) {}

  async create(params: {
    proposalId: string;
    spaceId: string;
    projectFolderId: string;
    files: SnapshotFile[];
    retentionDays?: number | null;
    maxCount?: number | null;
  }): Promise<void> {
    const retentionDays = params.retentionDays ?? SNAPSHOT_DEFAULT_RETENTION_DAYS;
    const maxCount = params.maxCount ?? SNAPSHOT_DEFAULT_MAX_COUNT;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

    await this.db.query(
      `INSERT INTO code_patch_snapshots
         (id, proposal_id, space_id, project_folder_id, files_json, created_at, expires_at, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'available')`,
      [
        randomUUID(),
        params.proposalId,
        params.spaceId,
        params.projectFolderId,
        JSON.stringify(params.files),
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );

    // Prune over-limit snapshots for this Folder (keep newest maxCount)
    await this.db.query(
      `UPDATE code_patch_snapshots
          SET status = 'pruned'
        WHERE project_folder_id = $1
          AND status = 'available'
          AND id NOT IN (
            SELECT id FROM code_patch_snapshots
             WHERE project_folder_id = $1 AND status = 'available'
             ORDER BY created_at DESC
             LIMIT $2
          )`,
      [params.projectFolderId, maxCount],
    );
  }

  async getByProposal(proposalId: string, spaceId: string): Promise<CodePatchSnapshotOut | null> {
    const result = await this.db.query<SnapshotRow>(
      `SELECT id, proposal_id, space_id, project_folder_id, files_json,
              created_at, expires_at, status, rolled_back_by_user_id, rolled_back_at
         FROM code_patch_snapshots
        WHERE proposal_id = $1 AND space_id = $2
          AND status = 'available'
          AND expires_at > NOW()
        LIMIT 1`,
      [proposalId, spaceId],
    );
    const row = result.rows[0];
    return row ? snapshotToOut(row) : null;
  }

  async markRolledBack(snapshotId: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE code_patch_snapshots
          SET status = 'rolled_back',
              rolled_back_by_user_id = $2,
              rolled_back_at = $3
        WHERE id = $1 AND status = 'available'`,
      [snapshotId, userId, new Date().toISOString()],
    );
  }
}

function snapshotToOut(row: SnapshotRow): CodePatchSnapshotOut {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    space_id: row.space_id,
    project_folder_id: row.project_folder_id,
    files: Array.isArray(row.files_json) ? row.files_json : [],
    created_at: dateIso(row.created_at),
    expires_at: dateIso(row.expires_at),
    status: row.status,
    rolled_back_by_user_id: row.rolled_back_by_user_id,
    rolled_back_at: row.rolled_back_at != null ? dateIso(row.rolled_back_at) : null,
  };
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}
