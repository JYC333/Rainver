import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import { getOrCreateSpaceRetrievalSettings, type SpaceRetrievalSettingsOut } from "../retrieval/settings.js";

export interface SpaceMember {
  user_id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  role: string;
  joined_at: string;
}

export interface SpaceFailure {
  statusCode: number;
  detail: string;
}

export interface SnapshotDefaults {
  snapshot_retention_days_default: number | null;
  snapshot_max_count_default: number | null;
}

export interface SpaceRepository {
  listMembers(userId: string, spaceId: string): Promise<SpaceMember[] | SpaceFailure>;
  getSnapshotDefaults(userId: string, spaceId: string): Promise<SnapshotDefaults | SpaceFailure>;
  getContentEgressSetting(
    userId: string,
    spaceId: string,
  ): Promise<{ space_id: string; member_copy_out_enabled: boolean } | SpaceFailure>;
  getRetrievalSettings(
    userId: string,
    spaceId: string,
  ): Promise<SpaceRetrievalSettingsOut | SpaceFailure>;
}

let repositoryOverride: SpaceRepository | null = null;

export function __setSpaceRepositoryForTests(repository: SpaceRepository | null): void {
  repositoryOverride = repository;
}

export function spaceRepositoryFromConfig(config: ServerConfig): SpaceRepository | null {
  if (repositoryOverride) return repositoryOverride;
  if (!config.databaseUrl) return null;
  return new PgSpaceRepository(getDbPool(config.databaseUrl));
}

function asIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export class PgSpaceRepository implements SpaceRepository {
  constructor(private readonly pool: Pool) {}

  async listMembers(userId: string, spaceId: string): Promise<SpaceMember[] | SpaceFailure> {
    const role = await this.activeRole(userId, spaceId);
    if (!role) return { statusCode: 403, detail: "Not a member of this space" };
    const res = await this.pool.query<{
      user_id: string;
      email: string | null;
      display_name: string;
      avatar_url: string | null;
      role: string;
      joined_at: Date | string;
    }>(
      `SELECT u.id AS user_id, u.email, u.display_name, u.avatar_url,
              m.role, m.created_at AS joined_at
         FROM space_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.space_id = $1 AND m.status = 'active'
        ORDER BY m.created_at ASC, m.id ASC`,
      [spaceId],
    );
    return res.rows.map((row) => ({
      user_id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      role: row.role,
      joined_at: asIso(row.joined_at),
    }));
  }

  async getSnapshotDefaults(userId: string, spaceId: string): Promise<SnapshotDefaults | SpaceFailure> {
    const role = await this.activeRole(userId, spaceId);
    if (!role) return { statusCode: 403, detail: "Not a member of this space" };
    const res = await this.pool.query<SnapshotDefaults>(
      `SELECT snapshot_retention_days_default, snapshot_max_count_default
         FROM spaces WHERE id = $1 LIMIT 1`,
      [spaceId],
    );
    return res.rows[0] ?? { snapshot_retention_days_default: null, snapshot_max_count_default: null };
  }

  /**
   * Whether members may take content out of this Space into a personal one
   * (ADR 0013 amendment 6b). Readable by any member — the boundary you are
   * working inside should not be a secret — but changed only by an owner or
   * admin, and off until one of them says otherwise.
   */
  async getContentEgressSetting(
    userId: string,
    spaceId: string,
  ): Promise<{ space_id: string; member_copy_out_enabled: boolean } | SpaceFailure> {
    const role = await this.activeRole(userId, spaceId);
    if (!role) return { statusCode: 403, detail: "Not a member of this space" };
    const res = await this.pool.query<{ member_copy_out_enabled: boolean }>(
      `SELECT member_copy_out_enabled FROM spaces WHERE id = $1 LIMIT 1`,
      [spaceId],
    );
    const row = res.rows[0];
    if (!row) return { statusCode: 404, detail: "Space not found" };
    return { space_id: spaceId, member_copy_out_enabled: row.member_copy_out_enabled };
  }

  async getRetrievalSettings(
    userId: string,
    spaceId: string,
  ): Promise<SpaceRetrievalSettingsOut | SpaceFailure> {
    const role = await this.activeRole(userId, spaceId);
    if (!role) return { statusCode: 403, detail: "Not a member of this space" };
    return getOrCreateSpaceRetrievalSettings(this.pool, spaceId);
  }

  private async activeRole(userId: string, spaceId: string): Promise<string | null> {
    const res = await this.pool.query<{ role: string }>(
      `SELECT role FROM space_memberships
        WHERE user_id = $1 AND space_id = $2 AND status = 'active'
        LIMIT 1`,
      [userId, spaceId],
    );
    return res.rows[0]?.role ?? null;
  }

}
