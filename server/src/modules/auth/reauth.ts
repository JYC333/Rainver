import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { authCookieHeader } from "./authCookie.js";
import { hashOpaqueToken } from "./securityPolicy.js";

/**
 * Recent-authentication grants (`auth_reauth_grants`).
 *
 * Verifying a password or completing a Google reauthentication issues one
 * grant: an unpredictable token in an HttpOnly cookie, stored only as its
 * digest, bound to the person *and the session* it was issued under, valid
 * for ten minutes. `status` is read-only. A sensitive mutation *consumes*
 * the grant with one conditional update — not consumed, not expired, this
 * user, this session, an operation it covers — so a replayed cookie, another
 * session's cookie, or two concurrent uses of one grant all fail. The grant
 * goes with its session: logout, revocation and disabling delete sessions,
 * and the row cascades.
 */
const COOKIE = "rainver.reauth";
const MAX_AGE_SECONDS = 10 * 60;

export type ReauthMethod = "password" | "google";

/** The mutations a grant may be spent on; each spends it exactly once. */
export type ReauthOperation = "password_set" | "password_change" | "google_link" | "google_unlink";

function cookieValue(request: FastifyRequest): string | null {
  const header = Array.isArray(request.headers.cookie) ? request.headers.cookie[0] : request.headers.cookie;
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== COOKIE || rest.length === 0) continue;
    return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Issues a grant for this user at this session and sets its cookie. */
export async function issueReauthGrant(
  db: Queryable,
  reply: FastifyReply,
  config: ServerConfig,
  input: { userId: string; sessionId: string; method: ReauthMethod },
): Promise<{ expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MAX_AGE_SECONDS * 1000);
  await db.query(
    `INSERT INTO auth_reauth_grants (id, token_hash, user_id, session_id, method, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), $6)`,
    [randomUUID(), hashOpaqueToken(token), input.userId, input.sessionId, input.method, expiresAt.toISOString()],
  );
  reply.header("set-cookie", authCookieHeader(config, { name: COOKIE, value: token, maxAgeSeconds: MAX_AGE_SECONDS }));
  return { expiresAt };
}

/** When the grant this request carries expires, or null when it carries none that is live. Reads only. */
export async function reauthGrantExpiresAt(
  db: Queryable,
  request: FastifyRequest,
  input: { userId: string; sessionId: string },
): Promise<Date | null> {
  const token = cookieValue(request);
  if (!token) return null;
  const result = await db.query<{ expires_at: string | Date }>(
    `SELECT expires_at FROM auth_reauth_grants
      WHERE token_hash = $1 AND user_id = $2 AND session_id = $3
        AND consumed_at IS NULL AND expires_at > now()
      LIMIT 1`,
    [hashOpaqueToken(token), input.userId, input.sessionId],
  );
  const row = result.rows[0];
  return row ? new Date(row.expires_at) : null;
}

/**
 * Spends the grant on one operation. True when this call was the one that
 * spent it; false when there was nothing live to spend — never issued,
 * expired, another user's or session's, or already spent by a request that
 * got there first. The caller runs this inside the mutation's own
 * transaction where the mutation is local, and before a mutation Better Auth
 * performs, so a grant is never spent twice.
 */
export async function consumeReauthGrant(
  db: Queryable,
  request: FastifyRequest,
  input: { userId: string; sessionId: string; operation: ReauthOperation },
): Promise<boolean> {
  const token = cookieValue(request);
  if (!token) return false;
  const result = await db.query<{ id: string }>(
    `UPDATE auth_reauth_grants
        SET consumed_at = now(), consumed_for = $4
      WHERE token_hash = $1 AND user_id = $2 AND session_id = $3
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id`,
    [hashOpaqueToken(token), input.userId, input.sessionId, input.operation],
  );
  return result.rowCount === 1;
}

/** Revokes every grant of a session, for a logout that keeps the session row for Better Auth to delete. */
export async function revokeSessionReauthGrants(db: Queryable, sessionId: string): Promise<void> {
  await db.query(`DELETE FROM auth_reauth_grants WHERE session_id = $1`, [sessionId]);
}

export function clearReauthCookie(reply: FastifyReply, config: ServerConfig): void {
  reply.header("set-cookie", authCookieHeader(config, { name: COOKIE, value: "", maxAgeSeconds: 0 }));
}
