import { createHash, randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool, type Pool } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import {
  getOrCreateSpaceRetrievalSettings,
  updateSpaceRetrievalSettings,
  type SpaceRetrievalSettingsOut,
} from "../retrieval/settings";
import type {
  SpaceRetrievalSettingsUpdate,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { isSpaceOwnerOrAdmin } from "../access/roles";
import { seedSpaceDefaults } from "./spaceSeeds";
import { loadProtocol } from "../providers/protocolRuntime";

export interface SpaceCreateInput {
  name: string;
  type?: "personal" | "household" | "team";
  /** Immutable after creation; validated against SPACE_OVERSIGHT_MODE_VALUES. Defaults to 'none'. */
  oversight_mode?: string;
}

export interface InvitationCreateInput {
  email: string;
  role?: "guest" | "member" | "reviewer" | "admin";
}

export interface SpaceResult {
  id: string;
  name: string;
  type: string;
  created_by_user_id: string | null;
  oversight_mode: string;
  egress_notifications_enabled: boolean;
  created_at: string;
  updated_at: string;
  role?: string | null;
}

export interface SpaceMember {
  user_id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  role: string;
  joined_at: string;
}

export interface InvitationResult {
  id: string;
  space_id: string;
  invited_email: string;
  role: string;
  token: string;
  status: string;
  expires_at: string;
}

export interface InvitationAcceptResult {
  space_id: string;
  role: string;
  space_name: string | null;
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
  createSpace(userId: string, input: SpaceCreateInput): Promise<SpaceResult | SpaceFailure>;
  listMembers(userId: string, spaceId: string): Promise<SpaceMember[] | SpaceFailure>;
  createInvitation(
    userId: string,
    spaceId: string,
    input: InvitationCreateInput,
  ): Promise<InvitationResult | SpaceFailure>;
  acceptInvitation(input: {
    token: string;
    userId: string;
    userEmail: string | null;
  }): Promise<InvitationAcceptResult | SpaceFailure>;
  getSnapshotDefaults(userId: string, spaceId: string): Promise<SnapshotDefaults | SpaceFailure>;
  updateSnapshotDefaults(
    userId: string,
    spaceId: string,
    data: SnapshotDefaults,
  ): Promise<SnapshotDefaults | SpaceFailure>;
  getContentEgressSetting(
    userId: string,
    spaceId: string,
  ): Promise<{ space_id: string; member_copy_out_enabled: boolean } | SpaceFailure>;
  updateContentEgressSetting(
    userId: string,
    spaceId: string,
    enabled: boolean,
  ): Promise<{ space_id: string; member_copy_out_enabled: boolean } | SpaceFailure>;
  getRetrievalSettings(
    userId: string,
    spaceId: string,
  ): Promise<SpaceRetrievalSettingsOut | SpaceFailure>;
  updateRetrievalSettings(
    userId: string,
    spaceId: string,
    data: SpaceRetrievalSettingsUpdate,
  ): Promise<SpaceRetrievalSettingsOut | SpaceFailure>;
}

type SpaceRow = {
  id: string;
  name: string;
  type: string;
  created_by_user_id: string | null;
  oversight_mode: string;
  egress_notifications_enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  role?: string | null;
};

const ROLE_RANK = new Map([
  ["guest", 0],
  ["member", 1],
  ["reviewer", 2],
  ["admin", 3],
  ["owner", 4],
]);

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

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function normalizeRole(raw: string | null | undefined): string {
  const lower = (raw ?? "").trim().toLowerCase();
  return ROLE_RANK.has(lower) ? lower : "guest";
}

function hasRoleAtLeast(role: string | null | undefined, required: string): boolean {
  return (ROLE_RANK.get(normalizeRole(role)) ?? 0) >= (ROLE_RANK.get(required) ?? 0);
}

function spaceOut(row: SpaceRow): SpaceResult {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    created_by_user_id: row.created_by_user_id,
    oversight_mode: row.oversight_mode,
    egress_notifications_enabled: row.egress_notifications_enabled,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    ...(row.role !== undefined ? { role: row.role } : {}),
  };
}

function rawInvitationToken(): string {
  return Buffer.from(randomUUID() + randomUUID()).toString("base64url");
}

export class PgSpaceRepository implements SpaceRepository {
  constructor(private readonly pool: Pool) {}

  async createSpace(userId: string, input: SpaceCreateInput): Promise<SpaceResult | SpaceFailure> {
    const type = input.type ?? "team";
    if (type === "personal") {
      return { statusCode: 400, detail: "Cannot explicitly create a personal space" };
    }
    let oversightMode = "none";
    if (input.oversight_mode !== undefined) {
      const protocol = await loadProtocol();
      if (!protocol.isSpaceOversightMode(input.oversight_mode)) {
        return { statusCode: 422, detail: "Invalid oversight_mode" };
      }
      oversightMode = input.oversight_mode;
    }
    return withTransaction(this.pool, async (client) => {
      const spaceId = randomUUID();
      await client.query(
        `INSERT INTO spaces
           (id, name, type, created_by_user_id, oversight_mode,
            egress_notifications_enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
        [spaceId, input.name, type, userId, oversightMode, type === "team"],
      );
      await client.query(
        `INSERT INTO space_memberships
           (id, space_id, user_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
        [randomUUID(), spaceId, userId],
      );
      await seedSpaceDefaults(client, spaceId, userId);
      const row = await this.getSpaceRow(spaceId, userId, client);
      return spaceOut({ ...row!, role: "owner" });
    });
  }

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

  async createInvitation(
    userId: string,
    spaceId: string,
    input: InvitationCreateInput,
  ): Promise<InvitationResult | SpaceFailure> {
    const role = await this.activeRole(userId, spaceId);
    if (!hasRoleAtLeast(role, "admin")) {
      return { statusCode: 403, detail: "Requires admin role to invite" };
    }
    const space = await this.pool.query<{ type: string }>(
      "SELECT type FROM spaces WHERE id = $1 LIMIT 1",
      [spaceId],
    );
    if (!space.rowCount) return { statusCode: 404, detail: "Space not found" };
    if (space.rows[0]?.type === "personal") {
      return { statusCode: 403, detail: "Personal spaces cannot have additional members" };
    }

    const token = rawInvitationToken();
    const roleToGrant = input.role ?? "member";
    const id = randomUUID();
    const res = await this.pool.query<{
      status: string;
      expires_at: Date | string;
    }>(
      `INSERT INTO space_invitations
         (id, space_id, invited_email, role, token_hash, status,
          invited_by_user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, now(), now() + interval '7 days')
       RETURNING status, expires_at`,
      [id, spaceId, input.email, roleToGrant, hashToken(token), userId],
    );
    return {
      id,
      space_id: spaceId,
      invited_email: input.email,
      role: roleToGrant,
      token,
      status: res.rows[0].status,
      expires_at: asIso(res.rows[0].expires_at),
    };
  }

  async acceptInvitation(input: {
    token: string;
    userId: string;
    userEmail: string | null;
  }): Promise<InvitationAcceptResult | SpaceFailure> {
    return withTransaction(this.pool, async (client) => {
      const inv = await client.query<{
        id: string;
        space_id: string;
        invited_email: string;
        role: string;
        status: string;
        expires_at: Date | string;
      }>("SELECT id, space_id, invited_email, role, status, expires_at FROM space_invitations WHERE token_hash = $1 LIMIT 1", [
        hashToken(input.token),
      ]);
      const invitation = inv.rows[0];
      if (!invitation) return { statusCode: 404, detail: "Invitation not found" };
      if (invitation.status !== "pending") {
        return { statusCode: 409, detail: `Invitation is already ${invitation.status}` };
      }
      if (new Date(invitation.expires_at).getTime() < Date.now()) {
        await client.query("UPDATE space_invitations SET status = 'expired' WHERE id = $1", [
          invitation.id,
        ]);
        return { statusCode: 410, detail: "Invitation has expired" };
      }
      if (
        !input.userEmail ||
        input.userEmail.toLowerCase() !== invitation.invited_email.toLowerCase()
      ) {
        return {
          statusCode: 403,
          detail: "This invitation was sent to a different email address",
        };
      }
      const existing = await client.query(
        `SELECT 1 FROM space_memberships
          WHERE space_id = $1 AND user_id = $2
          LIMIT 1`,
        [invitation.space_id, input.userId],
      );
      if (existing.rowCount) {
        return { statusCode: 409, detail: "Already a member of this space" };
      }
      await client.query(
        `INSERT INTO space_memberships
           (id, space_id, user_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', now(), now())`,
        [randomUUID(), invitation.space_id, input.userId, invitation.role],
      );
      await client.query(
        "UPDATE space_invitations SET status = 'accepted', accepted_at = now() WHERE id = $1",
        [invitation.id],
      );
      const space = await client.query<{ name: string }>(
        "SELECT name FROM spaces WHERE id = $1 LIMIT 1",
        [invitation.space_id],
      );
      return {
        space_id: invitation.space_id,
        role: invitation.role,
        space_name: space.rows[0]?.name ?? null,
      };
    });
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

  async updateSnapshotDefaults(
    userId: string,
    spaceId: string,
    data: SnapshotDefaults,
  ): Promise<SnapshotDefaults | SpaceFailure> {
    const role = await this.activeRole(userId, spaceId);
    if (!isSpaceOwnerOrAdmin(role)) {
      return { statusCode: 403, detail: "Requires space owner or admin role" };
    }
    await this.pool.query(
      `UPDATE spaces
          SET snapshot_retention_days_default = $1,
              snapshot_max_count_default = $2,
              updated_at = now()
        WHERE id = $3`,
      [data.snapshot_retention_days_default, data.snapshot_max_count_default, spaceId],
    );
    return data;
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

  async updateContentEgressSetting(
    userId: string,
    spaceId: string,
    enabled: boolean,
  ): Promise<{ space_id: string; member_copy_out_enabled: boolean } | SpaceFailure> {
    const role = await this.activeRole(userId, spaceId);
    if (!isSpaceOwnerOrAdmin(role)) {
      return { statusCode: 403, detail: "Requires space owner or admin role" };
    }
    const res = await this.pool.query(
      `UPDATE spaces SET member_copy_out_enabled = $1, updated_at = now() WHERE id = $2`,
      [enabled, spaceId],
    );
    if ((res.rowCount ?? 0) === 0) return { statusCode: 404, detail: "Space not found" };
    return { space_id: spaceId, member_copy_out_enabled: enabled };
  }

  async getRetrievalSettings(
    userId: string,
    spaceId: string,
  ): Promise<SpaceRetrievalSettingsOut | SpaceFailure> {
    const role = await this.activeRole(userId, spaceId);
    if (!role) return { statusCode: 403, detail: "Not a member of this space" };
    return getOrCreateSpaceRetrievalSettings(this.pool, spaceId);
  }

  async updateRetrievalSettings(
    userId: string,
    spaceId: string,
    data: SpaceRetrievalSettingsUpdate,
  ): Promise<SpaceRetrievalSettingsOut | SpaceFailure> {
    const role = await this.activeRole(userId, spaceId);
    if (!isSpaceOwnerOrAdmin(role)) {
      return { statusCode: 403, detail: "Requires space owner or admin role" };
    }
    return updateSpaceRetrievalSettings(this.pool, spaceId, data, { actorUserId: userId });
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

  private async getSpaceRow(
    spaceId: string,
    userId: string,
    client: { query: Pool["query"] },
  ): Promise<SpaceRow | null> {
    const res = await client.query<SpaceRow>(
      `SELECT s.id, s.name, s.type, s.created_by_user_id, s.oversight_mode,
              s.egress_notifications_enabled,
              s.created_at, s.updated_at, m.role
         FROM spaces s
         LEFT JOIN space_memberships m
           ON m.space_id = s.id AND m.user_id = $2
        WHERE s.id = $1
        LIMIT 1`,
      [spaceId, userId],
    );
    return res.rows[0] ?? null;
  }
}
