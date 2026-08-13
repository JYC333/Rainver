import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ServerConfig } from "../../config";
import type { AuthenticatedIdentity } from "../../gateway/requestContext";
import { getDbPool, type Pool } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import { seedSpaceDefaults } from "../spaces/spaceSeeds";

const SESSION_COOKIE = "session_id";
export const API_KEYS_NOT_IMPLEMENTED =
  "API key storage is not in the canonical schema (ApiKey is deferred).";

export type IntrospectionResult =
  | { ok: true; spaceId: string; userId: string }
  | {
      ok: false;
      reason: "denied" | "unavailable" | "contract_violation";
      statusCode: number;
      body: string;
    };

export interface CurrentUser {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  is_instance_admin: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface UserSpace {
  id: string;
  name: string;
  type: string;
  role: string;
  /** Immutable, creation-time only. Visible to every member (transparency requirement). */
  oversight_mode: string;
  egress_notifications_enabled: boolean;
  /**
   * Active members, the client's signal for whether a "team / mine" division
   * means anything here. A single-member Space has no team to divide from, and
   * showing the ladder there is noise rather than a privacy affordance — the
   * stored model is identical either way.
   */
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface SpaceView extends UserSpace {
  created_by_user_id: string | null;
}

export interface AuthRepository {
  resolveIdentity(input: {
    authorization?: string;
    sessionToken?: string;
    requestedSpaceId?: string;
  }): Promise<IntrospectionResult>;
  getCurrentUser(sessionToken?: string): Promise<CurrentUser | AuthFailure>;
  getUserSpaces(userId: string): Promise<UserSpace[]>;
  getSpaceForUser(userId: string, spaceId: string): Promise<SpaceView | AuthFailure | null>;
  logout(sessionToken?: string): Promise<void>;
  findOrCreateFromGoogle(input: {
    googleSub: string;
    email: string;
    displayName: string;
    avatarUrl?: string | null;
  }): Promise<CurrentUser>;
  createSession(userId: string, expireDays: number): Promise<string>;
}

export interface AuthFailure {
  statusCode: number;
  detail: string;
}

type SessionRow = {
  id: string;
  user_id: string;
  expires_at: Date | string;
};

type UserRow = {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  created_at: Date | string;
  last_login_at: Date | string | null;
};

type SpaceRow = {
  id: string;
  name: string;
  type: string;
  role: string;
  created_by_user_id: string | null;
  oversight_mode: string;
  egress_notifications_enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  member_count?: string | number;
};

let repositoryOverride: AuthRepository | null = null;
let identityOverride:
  | AuthenticatedIdentity
  | ((request: FastifyRequest) => Promise<AuthenticatedIdentity | null> | AuthenticatedIdentity | null)
  | null = null;

export function __setAuthRepositoryForTests(repository: AuthRepository | null): void {
  repositoryOverride = repository;
}

export function __setAuthIdentityForTests(
  identity:
    | AuthenticatedIdentity
    | ((request: FastifyRequest) => Promise<AuthenticatedIdentity | null> | AuthenticatedIdentity | null)
    | null,
): void {
  identityOverride = identity;
}

export function authRepositoryFromConfig(config: ServerConfig): AuthRepository | null {
  if (repositoryOverride) return repositoryOverride;
  if (!config.databaseUrl) return null;
  return new PgAuthRepository(getDbPool(config.databaseUrl), config.instanceAdminEmail);
}

export async function introspectIdentity(
  config: ServerConfig,
  request: FastifyRequest,
): Promise<IntrospectionResult> {
  if (identityOverride) {
    const value =
      typeof identityOverride === "function" ? await identityOverride(request) : identityOverride;
    if (value) return { ok: true, spaceId: value.spaceId, userId: value.userId };
  }
  const repository = authRepositoryFromConfig(config);
  if (!repository) {
    request.log.warn("native identity requires SERVER_DATABASE_URL");
    return { ok: false, reason: "unavailable", statusCode: 502, body: "" };
  }
  const query = request.query as Record<string, unknown> | undefined;
  const requestedSpaceHeader = headerValue(request.headers["x-agent-space-id"]);
  return repository.resolveIdentity({
    authorization: headerValue(request.headers.authorization),
    sessionToken: cookieValue(headerValue(request.headers.cookie), SESSION_COOKIE),
    requestedSpaceId:
      requestedSpaceHeader ?? (typeof query?.space_id === "string" ? query.space_id : undefined),
  });
}

export function sessionTokenFromRequest(request: FastifyRequest): string | undefined {
  return cookieValue(headerValue(request.headers.cookie), SESSION_COOKIE);
}

export function authFailureBody(detail: string): string {
  return JSON.stringify({ detail });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const rawPart of cookieHeader.split(";")) {
    const part = rawPart.trim();
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq) !== name) continue;
    const value = part.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function sessionToken(): string {
  return randomBytes(32).toString("hex");
}

function asIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function now(): Date {
  return new Date();
}

export class PgAuthRepository implements AuthRepository {
  constructor(
    private readonly pool: Pool,
    private readonly instanceAdminEmail: string | null = null,
  ) {}

  async resolveIdentity(input: {
    authorization?: string;
    sessionToken?: string;
    requestedSpaceId?: string;
  }): Promise<IntrospectionResult> {
    if (input.authorization?.startsWith("Bearer ")) {
      return {
        ok: false,
        reason: "denied",
        statusCode: 501,
        body: authFailureBody(API_KEYS_NOT_IMPLEMENTED),
      };
    }
    const session = await this.validateSessionOrNull(input.sessionToken);
    if (!session) {
      return {
        ok: false,
        reason: "denied",
        statusCode: 401,
        body: authFailureBody("Authentication required"),
      };
    }
    const user = await this.getUserRow(session.user_id);
    if (!user) {
      return {
        ok: false,
        reason: "denied",
        statusCode: 401,
        body: authFailureBody("Authentication required"),
      };
    }
    const effectiveSpace =
      input.requestedSpaceId ?? (await this.selectDefaultSpace(user.id));
    if (!effectiveSpace) {
      return {
        ok: false,
        reason: "denied",
        statusCode: 403,
        body: authFailureBody("No active space selected"),
      };
    }
    if (!(await this.hasActiveMembership(user.id, effectiveSpace))) {
      return {
        ok: false,
        reason: "denied",
        statusCode: 403,
        body: authFailureBody("Not a member of this space"),
      };
    }
    return { ok: true, spaceId: effectiveSpace, userId: user.id };
  }

  async getCurrentUser(sessionToken?: string): Promise<CurrentUser | AuthFailure> {
    const session = await this.validateSession(sessionToken);
    if ("statusCode" in session) return session;
    const user = await this.getUserRow(session.user_id);
    if (!user) return { statusCode: 401, detail: "User not found" };
    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      is_instance_admin: isInstanceAdminEmail(user.email, this.instanceAdminEmail),
      created_at: asIso(user.created_at)!,
      last_login_at: asIso(user.last_login_at),
    };
  }

  async getUserSpaces(userId: string): Promise<UserSpace[]> {
    const res = await this.pool.query<SpaceRow>(
      `SELECT s.id, s.name, s.type, m.role, s.created_by_user_id, s.oversight_mode,
              s.egress_notifications_enabled, s.created_at, s.updated_at,
              (SELECT count(*) FROM space_memberships active
                WHERE active.space_id = s.id AND active.status = 'active') AS member_count
         FROM space_memberships m
         JOIN spaces s ON s.id = m.space_id
        WHERE m.user_id = $1 AND m.status = 'active'
        ORDER BY m.created_at ASC, m.id ASC`,
      [userId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      role: row.role,
      oversight_mode: row.oversight_mode,
      egress_notifications_enabled: row.egress_notifications_enabled,
      member_count: Number(row.member_count ?? 1),
      created_at: asIso(row.created_at)!,
      updated_at: asIso(row.updated_at)!,
    }));
  }

  async getSpaceForUser(userId: string, spaceId: string): Promise<SpaceView | AuthFailure | null> {
    const res = await this.pool.query<SpaceRow>(
      `SELECT s.id, s.name, s.type, m.role, s.created_by_user_id, s.oversight_mode,
              s.egress_notifications_enabled, s.created_at, s.updated_at,
              (SELECT count(*) FROM space_memberships active
                WHERE active.space_id = s.id AND active.status = 'active') AS member_count
         FROM spaces s
         JOIN space_memberships m ON m.space_id = s.id
        WHERE s.id = $1 AND m.user_id = $2 AND m.status = 'active'
        LIMIT 1`,
      [spaceId, userId],
    );
    const row = res.rows[0];
    if (!row) {
      const exists = await this.pool.query("SELECT 1 FROM spaces WHERE id = $1 LIMIT 1", [spaceId]);
      return exists.rowCount ? { statusCode: 403, detail: "Not authorized for this space" } : null;
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      role: row.role,
      oversight_mode: row.oversight_mode,
      egress_notifications_enabled: row.egress_notifications_enabled,
      member_count: Number(row.member_count ?? 1),
      created_by_user_id: row.created_by_user_id,
      created_at: asIso(row.created_at)!,
      updated_at: asIso(row.updated_at)!,
    };
  }

  async logout(sessionToken?: string): Promise<void> {
    if (!sessionToken) return;
    await this.pool.query("DELETE FROM user_sessions WHERE token_hash = $1", [
      hashToken(sessionToken),
    ]);
  }

  async findOrCreateFromGoogle(input: {
    googleSub: string;
    email: string;
    displayName: string;
    avatarUrl?: string | null;
  }): Promise<CurrentUser> {
    return withTransaction(this.pool, async (client) => {
      const account = await client.query<{ user_id: string }>(
        `SELECT user_id FROM auth_accounts
          WHERE provider = 'google' AND provider_user_id = $1
          LIMIT 1`,
        [input.googleSub],
      );
      if (account.rows[0]) {
        const updated = await client.query<UserRow>(
          `UPDATE users
              SET email = $2,
                  display_name = $3,
                  avatar_url = CASE
                    WHEN $4::text IS NULL OR $4::text = '' THEN avatar_url
                    ELSE $4
                  END,
                  last_login_at = now(),
                  updated_at = now()
            WHERE id = $1
            RETURNING id, email, display_name, avatar_url, created_at, last_login_at`,
          [account.rows[0].user_id, input.email, input.displayName, input.avatarUrl ?? null],
        );
        return currentUserFromRow(updated.rows[0], this.instanceAdminEmail);
      }

      const userId = randomUUID();
      const inserted = await client.query<UserRow>(
        `INSERT INTO users
           (id, email, display_name, avatar_url, status, last_login_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', now(), now(), now())
         RETURNING id, email, display_name, avatar_url, created_at, last_login_at`,
        [userId, input.email, input.displayName, input.avatarUrl ?? null],
      );
      await client.query(
        `INSERT INTO auth_accounts
           (id, user_id, provider, provider_user_id, email, created_at)
         VALUES ($1, $2, 'google', $3, $4, now())`,
        [randomUUID(), userId, input.googleSub, input.email],
      );
      const personalSpaceId = randomUUID();
      await client.query(
        `INSERT INTO spaces
           (id, name, type, created_by_user_id, egress_notifications_enabled,
            created_at, updated_at)
         VALUES ($1, $2, 'personal', $3, false, now(), now())`,
        [personalSpaceId, `${input.displayName}'s Personal Space`, userId],
      );
      await client.query(
        `INSERT INTO space_memberships
           (id, space_id, user_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
        [randomUUID(), personalSpaceId, userId],
      );
      await seedSpaceDefaults(client, personalSpaceId, userId);
      return currentUserFromRow(inserted.rows[0], this.instanceAdminEmail);
    });
  }

  async createSession(userId: string, expireDays: number): Promise<string> {
    const raw = sessionToken();
    await this.pool.query(
      `INSERT INTO user_sessions
         (id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES ($1, $2, $3, now(), now() + ($4::int * interval '1 day'), NULL)`,
      [randomUUID(), userId, hashToken(raw), expireDays],
    );
    return raw;
  }

  private async validateSessionOrNull(sessionToken?: string): Promise<SessionRow | null> {
    const result = await this.validateSession(sessionToken);
    return "statusCode" in result ? null : result;
  }

  private async validateSession(sessionToken?: string): Promise<SessionRow | AuthFailure> {
    if (!sessionToken) {
      return { statusCode: 401, detail: "Not authenticated. Sign in with Google." };
    }
    const res = await this.pool.query<SessionRow>(
      "SELECT id, user_id, expires_at FROM user_sessions WHERE token_hash = $1 LIMIT 1",
      [hashToken(sessionToken)],
    );
    const session = res.rows[0];
    if (!session) return { statusCode: 401, detail: "Invalid session" };
    if (new Date(session.expires_at).getTime() < now().getTime()) {
      return { statusCode: 401, detail: "Session expired" };
    }
    await this.pool.query("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [
      session.id,
    ]);
    return session;
  }

  private async getUserRow(userId: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserRow>(
      `SELECT id, email, display_name, avatar_url, created_at, last_login_at
         FROM users
        WHERE id = $1 AND status = 'active'
        LIMIT 1`,
      [userId],
    );
    return res.rows[0] ?? null;
  }

  private async hasActiveMembership(userId: string, spaceId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM space_memberships
        WHERE user_id = $1 AND space_id = $2 AND status = 'active'
        LIMIT 1`,
      [userId, spaceId],
    );
    return Boolean(res.rowCount);
  }

  private async selectDefaultSpace(userId: string): Promise<string | null> {
    const personal = await this.pool.query<{ space_id: string }>(
      `SELECT m.space_id
         FROM space_memberships m
         JOIN spaces s ON s.id = m.space_id
        WHERE m.user_id = $1 AND m.status = 'active' AND s.type = 'personal'
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT 1`,
      [userId],
    );
    if (personal.rows[0]) return personal.rows[0].space_id;
    const fallback = await this.pool.query<{ space_id: string }>(
      `SELECT space_id
         FROM space_memberships
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [userId],
    );
    return fallback.rows[0]?.space_id ?? null;
  }
}

function isInstanceAdminEmail(email: string | null, instanceAdminEmail: string | null): boolean {
  return Boolean(
    email &&
    instanceAdminEmail &&
    email.trim().toLowerCase() === instanceAdminEmail.trim().toLowerCase(),
  );
}

function currentUserFromRow(user: UserRow, instanceAdminEmail: string | null): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    is_instance_admin: isInstanceAdminEmail(user.email, instanceAdminEmail),
    created_at: asIso(user.created_at)!,
    last_login_at: asIso(user.last_login_at),
  };
}
