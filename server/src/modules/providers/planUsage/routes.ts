import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../../../config.js";
import { resolveIdentity, sendRouteError } from "../../routeUtils/common.js";
import { listApiPlanUsageProviders } from "./service.js";

export function registerApiPlanUsageRoutes(app: FastifyInstance, config: ServerConfig): void {
  app.get("/api/v1/providers/plan-usage", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    reply.header("Cache-Control", "no-store");
    try { return reply.send({ items: await listApiPlanUsageProviders(config, identity.spaceId, identity.userId) }); }
    catch (error) { return sendRouteError(reply, error); }
  });
}
