import type { FastifyReply } from "fastify";
import type { ServerConfig } from "../../config.js";
import { authRepositoryFromConfig } from "../auth/identity.js";
import { getDbPool } from "../../db/pool.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";

export async function requireSpaceOwnerOrAdmin(
  config: ServerConfig,
  identity: { spaceId: string; userId: string },
  reply: FastifyReply,
  message = "Requires space owner or admin role",
): Promise<boolean> {
  const repository = authRepositoryFromConfig(config);
  if (!repository) {
    reply.code(502).send({ detail: "Identity database is unavailable" });
    return false;
  }
  const space = await repository.getSpaceForUser(identity.userId, identity.spaceId);
  if (!space) {
    reply.code(404).send({ detail: "Space not found" });
    return false;
  }
  if ("statusCode" in space) {
    reply.code(space.statusCode).send({ detail: space.detail });
    return false;
  }
  if (!isSpaceOwnerOrAdmin(space.role)) {
    reply.code(403).send({ detail: message });
    return false;
  }
  return true;
}

/** Whether this user is the configured instance admin; answers nothing on the reply. */
export async function isInstanceAdmin(config: ServerConfig, userId: string): Promise<boolean> {
  if (!config.instanceAdminEmail || !config.databaseUrl) return false;
  const pool = getDbPool(config.databaseUrl);
  const res = await pool.query<{ email: string | null }>(
    `SELECT email FROM users WHERE id = $1 AND status = 'active' LIMIT 1`,
    [userId],
  );
  const email = res.rows[0]?.email ?? null;
  return Boolean(email && email.trim().toLowerCase() === config.instanceAdminEmail.trim().toLowerCase());
}

export async function requireInstanceAdmin(
  config: ServerConfig,
  identity: { userId: string },
  reply: FastifyReply,
  message = "Requires instance admin",
): Promise<boolean> {
  if (await isInstanceAdmin(config, identity.userId)) return true;
  reply.code(403).send({ detail: message });
  return false;
}
