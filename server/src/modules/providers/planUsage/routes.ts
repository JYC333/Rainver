import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../../../config.js";
import { HttpError, resolveIdentity, sendRouteError } from "../../routeUtils/common.js";
import { listApiPlanUsageProviders, refreshApiPlanUsage } from "./service.js";

export function registerApiPlanUsageRoutes(app: FastifyInstance, config: ServerConfig): void {
  app.get("/api/v1/providers/plan-usage", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    reply.header("Cache-Control", "no-store");
    try { return reply.send({ items: await listApiPlanUsageProviders(config, identity.spaceId, identity.userId) }); }
    catch (error) { return sendRouteError(reply, error); }
  });
  app.post("/api/v1/providers/:configId/plan-usage", async (request, reply) => {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return reply;
    reply.header("Cache-Control", "no-store");
    try {
      const { configId } = request.params as { configId: string };
      const snapshot = await refreshApiPlanUsage(config, identity.spaceId, identity.userId, configId);
      // The vendor wait is long and shared with other callers. Authorize this
      // request's own session again after it, from the database: a session
      // signed out or an account disabled meanwhile gets the refusal a new
      // request would, not the quota.
      const again = await resolveIdentity(config, request, reply);
      if (!again) return reply;
      if (again.spaceId !== identity.spaceId || again.userId !== identity.userId) throw new HttpError(409, "Your session changed during the query. Refresh again.");
      return reply.send(snapshot);
    } catch (error) { return sendRouteError(reply, error); }
  });
}
