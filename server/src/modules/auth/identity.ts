import type { FastifyRequest } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { AuthenticatedIdentity } from "../../gateway/requestContext.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import { createBetterAuth } from "./betterAuth.js";
import { hashOpaqueToken } from "./securityPolicy.js";

const SESSION_COOKIE = "better-auth.session_token";
export const API_KEYS_NOT_IMPLEMENTED = "API key storage is not in the canonical schema (ApiKey is deferred).";

export type IntrospectionResult =
  | { ok: true; spaceId: string; userId: string }
  | { ok: false; reason: "denied" | "unavailable" | "contract_violation"; statusCode: number; body: string };
export interface CurrentUser { id: string; email: string | null; display_name: string; avatar_url: string | null; is_instance_admin: boolean; created_at: string; last_login_at: string | null }
export interface UserSpace { id: string; name: string; type: string; role: string; oversight_mode: string; egress_notifications_enabled: boolean; member_count: number; created_at: string; updated_at: string }
export interface SpaceView extends UserSpace { created_by_user_id: string | null }
export interface AuthFailure { statusCode: number; detail: string }

/** The repository surface consumed by protected product modules. */
export interface AuthRepository {
  resolveIdentity(input: { authorization?: string; sessionToken?: string; requestedSpaceId?: string }): Promise<IntrospectionResult>;
  getCurrentUser(sessionToken?: string): Promise<CurrentUser | AuthFailure>;
  getUserSpaces(userId: string): Promise<UserSpace[]>;
  getSpaceForUser(userId: string, spaceId: string): Promise<SpaceView | AuthFailure | null>;
  logout(sessionToken?: string): Promise<void>;
}

type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
export interface AuthRuntime { auth: BetterAuthInstance; repository: PgAuthRepository; pool: Pool }

let repositoryOverride: AuthRepository | null = null;
let identityOverride:
  | AuthenticatedIdentity
  | ((request: FastifyRequest) => Promise<AuthenticatedIdentity | null> | AuthenticatedIdentity | null)
  | null = null;
let compositionRuntime: AuthRuntime | null = null;

export function __setAuthRepositoryForTests(repository: AuthRepository | null): void { repositoryOverride = repository }
export function __setAuthIdentityForTests(identity: typeof identityOverride): void { identityOverride = identity }

/** Bound once by the server composition root; it is not a secret-key cache. */
export function setAuthRuntimeForComposition(runtime: AuthRuntime | null): void { compositionRuntime = runtime }
export function createAuthRuntime(config: ServerConfig): AuthRuntime | null {
  if (!config.databaseUrl || !config.betterAuthSecret) return null;
  const pool = getDbPool(config.databaseUrl);
  const auth = createBetterAuth(config, pool);
  return { auth, pool, repository: new PgAuthRepository(pool, config.instanceAdminEmail, auth) };
}
export function authRepositoryFromConfig(config: ServerConfig): AuthRepository | null {
  if (repositoryOverride) return repositoryOverride;
  if (compositionRuntime) return compositionRuntime.repository;
  if (!config.databaseUrl) return null;
  return new PgAuthRepository(getDbPool(config.databaseUrl), config.instanceAdminEmail);
}

export async function introspectIdentity(config: ServerConfig, request: FastifyRequest): Promise<IntrospectionResult> {
  if (identityOverride) {
    const value = typeof identityOverride === "function" ? await identityOverride(request) : identityOverride;
    if (value) return { ok: true, spaceId: value.spaceId, userId: value.userId };
  }
  const repository = authRepositoryFromConfig(config);
  if (!repository) return { ok: false, reason: "unavailable", statusCode: 502, body: "" };
  const query = request.query as Record<string, unknown> | undefined;
  const requestedSpaceHeader = headerValue(request.headers["x-rainver-space-id"]);
  return repository.resolveIdentity({ authorization: headerValue(request.headers.authorization), sessionToken: sessionTokenFromRequest(request), requestedSpaceId: requestedSpaceHeader ?? (typeof query?.space_id === "string" ? query.space_id : undefined) });
}
export function sessionTokenFromRequest(request: FastifyRequest): string | undefined { return cookieValue(headerValue(request.headers.cookie), SESSION_COOKIE) }
export function authFailureBody(detail: string): string { return JSON.stringify({ detail }) }
function headerValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value }
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const raw of header.split(";")) {
    const part = raw.trim(); const eq = part.indexOf("=");
    if (eq <= 0 || part.slice(0, eq) !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1)) } catch { return part.slice(eq + 1) }
  }
  return undefined;
}
function logicalSessionToken(token: string): string { return token.split(".", 1)[0]! }
function asIso(value: Date | string | null): string | null { if (value === null) return null; return value instanceof Date ? value.toISOString() : new Date(value).toISOString() }
function isInstanceAdminEmail(email: string | null, admin: string | null): boolean { return Boolean(email && admin && email.trim().toLowerCase() === admin.trim().toLowerCase()) }

type UserRow = { id: string; email: string | null; display_name: string; avatar_url: string | null; status: string; created_at: Date | string; last_login_at: Date | string | null };
type SpaceRow = { id: string; name: string; type: string; role: string; created_by_user_id: string | null; oversight_mode: string; egress_notifications_enabled: boolean; created_at: Date | string; updated_at: Date | string; member_count?: string | number };
type SessionRow = { id: string; user_id: string; expires_at: Date | string };
type QueryClient = { query<T = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> };

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool, private readonly instanceAdminEmail: string | null = null, private readonly auth?: BetterAuthInstance) {}
  async resolveIdentity(input: { authorization?: string; sessionToken?: string; requestedSpaceId?: string }): Promise<IntrospectionResult> {
    if (input.authorization?.startsWith("Bearer ")) return { ok: false, reason: "denied", statusCode: 501, body: authFailureBody(API_KEYS_NOT_IMPLEMENTED) };
    const session = await this.validateSession(input.sessionToken);
    if (!session) return { ok: false, reason: "denied", statusCode: 401, body: authFailureBody("Authentication required") };
    const user = await this.getUserRow(session.user_id);
    if (!user || user.status !== "active") return { ok: false, reason: "denied", statusCode: 401, body: authFailureBody("Authentication required") };
    const spaceId = input.requestedSpaceId ?? await this.selectDefaultSpace(user.id);
    if (!spaceId) return { ok: false, reason: "denied", statusCode: 403, body: authFailureBody("No active space selected") };
    if (!(await this.hasActiveMembership(user.id, spaceId))) return { ok: false, reason: "denied", statusCode: 403, body: authFailureBody("Not a member of this space") };
    return { ok: true, spaceId, userId: user.id };
  }
  async getCurrentUser(sessionToken?: string): Promise<CurrentUser | AuthFailure> {
    const session = await this.validateSession(sessionToken); if (!session) return { statusCode: 401, detail: "Authentication required" };
    const user = await this.getUserRow(session.user_id); if (!user || user.status !== "active") return { statusCode: 401, detail: "Authentication required" };
    return currentUserFromRow(user, this.instanceAdminEmail);
  }
  async getUserSpaces(userId: string): Promise<UserSpace[]> {
    const result = await this.pool.query<SpaceRow>(`SELECT s.id, s.name, s.type, m.role, s.created_by_user_id, s.oversight_mode,
      s.egress_notifications_enabled, s.created_at, s.updated_at,
      (SELECT count(*) FROM space_memberships active WHERE active.space_id = s.id AND active.status = 'active') AS member_count
      FROM space_memberships m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = $1 AND m.status = 'active' ORDER BY m.created_at ASC, m.id ASC`, [userId]);
    return result.rows.map(spaceFromRow);
  }
  async getSpaceForUser(userId: string, spaceId: string): Promise<SpaceView | AuthFailure | null> {
    const result = await this.pool.query<SpaceRow>(`SELECT s.id, s.name, s.type, m.role, s.created_by_user_id, s.oversight_mode,
      s.egress_notifications_enabled, s.created_at, s.updated_at,
      (SELECT count(*) FROM space_memberships active WHERE active.space_id = s.id AND active.status = 'active') AS member_count
      FROM spaces s JOIN space_memberships m ON m.space_id = s.id WHERE s.id = $1 AND m.user_id = $2 AND m.status = 'active' LIMIT 1`, [spaceId, userId]);
    if (result.rows[0]) return { ...spaceFromRow(result.rows[0]), created_by_user_id: result.rows[0].created_by_user_id };
    const exists = await this.pool.query("SELECT 1 FROM spaces WHERE id = $1 LIMIT 1", [spaceId]);
    return exists.rowCount ? { statusCode: 403, detail: "Not authorized for this space" } : null;
  }
  async logout(sessionToken?: string): Promise<void> { if (sessionToken) await this.pool.query("DELETE FROM user_sessions WHERE token_hash = $1", [hashOpaqueToken(logicalSessionToken(sessionToken))]) }

  private async validateSession(token?: string): Promise<SessionRow | null> {
    if (!token) return null;
    if (this.auth) {
      try {
        const session = await this.auth.api.getSession({ headers: new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` }) });
        if (session?.session?.userId) return { id: session.session.id, user_id: session.session.userId, expires_at: session.session.expiresAt };
      } catch { /* fall through to the same generic SQL read */ }
    }
    const result = await this.pool.query<SessionRow>("SELECT id, user_id, expires_at FROM user_sessions WHERE token_hash = $1 LIMIT 1", [hashOpaqueToken(logicalSessionToken(token))]);
    const row = result.rows[0]; if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
    await this.pool.query("UPDATE user_sessions SET updated_at = now() WHERE id = $1", [row.id]); return row;
  }
  private async getUserRow(userId: string, client: QueryClient = this.pool as unknown as QueryClient): Promise<UserRow | null> { const result = await client.query<UserRow>("SELECT id, email, display_name, avatar_url, status, created_at, last_login_at FROM users WHERE id = $1 LIMIT 1", [userId]); return result.rows[0] ?? null }
  private async hasActiveMembership(userId: string, spaceId: string): Promise<boolean> { const result = await this.pool.query("SELECT 1 FROM space_memberships WHERE user_id = $1 AND space_id = $2 AND status = 'active' LIMIT 1", [userId, spaceId]); return Boolean(result.rowCount) }
  private async selectDefaultSpace(userId: string): Promise<string | null> { const result = await this.pool.query<{ space_id: string }>(`SELECT m.space_id FROM space_memberships m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = $1 AND m.status = 'active' ORDER BY (s.type = 'personal') DESC, m.created_at ASC, m.id ASC LIMIT 1`, [userId]); return result.rows[0]?.space_id ?? null }
}

function spaceFromRow(row: SpaceRow): UserSpace { return { id: row.id, name: row.name, type: row.type, role: row.role, oversight_mode: row.oversight_mode, egress_notifications_enabled: row.egress_notifications_enabled, member_count: Number(row.member_count ?? 1), created_at: asIso(row.created_at)!, updated_at: asIso(row.updated_at)! } }
function currentUserFromRow(user: UserRow, admin: string | null): CurrentUser { return { id: user.id, email: user.email, display_name: user.display_name, avatar_url: user.avatar_url, is_instance_admin: isInstanceAdminEmail(user.email, admin), created_at: asIso(user.created_at)!, last_login_at: asIso(user.last_login_at) } }
