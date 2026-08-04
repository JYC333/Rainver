/**
 * System module routes (server-owned).
 *
 * - GET /health                          plain liveness (container/LB probe)
 * - GET /api/v1/server/health     namespaced liveness
 * - GET /api/v1/status                   component-level runtime status
 * - GET /api/v1/server/features   server-side feature advertisement
 * - GET /api/v1/features                 product-shaped feature list
 *
 * Read-only descriptors of the server itself. As real server-side features ship as server modules, they
 * should be advertised in the features route.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { computeFeatures, featuresBody, healthBody } from "./service";
import {
  buildStatusBody,
  databaseUnavailableStatusBody,
  isDatabaseReachable,
} from "./statusService";
import { getDbPool } from "../../db/pool";
import { resolveIdentity } from "../routeUtils/common";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const health = async (_request: FastifyRequest, reply: FastifyReply) => {
    const body = await healthBody(context.config);
    if (body.status !== "ok") reply.code(503);
    return body;
  };
  app.get("/health", health);
  app.get("/api/v1/server/health", health);

  app.get("/api/v1/status", async (request, reply) => {
    // Database reachability is checked before authorization so the endpoint
    // still answers when Postgres is down — the documented invariant — without
    // handing operational internals to a caller who could not be authorized.
    const databaseOk = await isDatabaseReachable(context.config);
    if (!databaseOk) {
      return reply.code(503).send(databaseUnavailableStatusBody(context.config));
    }

    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await isSpaceOwnerOrAdmin(context.config, identity.spaceId, identity.userId))) {
      // Task names, last error text, worker id, and instance-wide queue depth
      // are operator data; ordinary members do not get them.
      return reply.code(403).send({ detail: "Space owner or admin role required" });
    }

    const body = await buildStatusBody(context.config, { databaseOk: true });
    if (body.overall === "error") reply.code(503);
    return body;
  });
  app.get("/api/v1/server/features", async () => featuresBody(context.config));

  app.get("/api/v1/features", async () =>
    computeFeatures(context.config).map((id) => ({
      id,
      name: id,
      always_on: true,
      enabled: true,
    })),
  );
}

async function isSpaceOwnerOrAdmin(
  config: ModuleContext["config"],
  spaceId: string,
  userId: string,
): Promise<boolean> {
  if (!config.databaseUrl) return false;
  const result = await getDbPool(config.databaseUrl).query<{ role: string }>(
    `SELECT role FROM space_memberships
      WHERE user_id = $1 AND space_id = $2 AND status = 'active'
      LIMIT 1`,
    [userId, spaceId],
  );
  const role = result.rows[0]?.role;
  return role === "owner" || role === "admin";
}
