import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { isInstanceAdmin } from "../routeUtils/access.js";
import { readSubscriptionQuotaPools } from "./subscriptionUsage.js";

export function registerSubscriptionUsageRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/hosts/subscription-usage", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const pool = dbPool(context.config);
      return reply.send({ items: await readSubscriptionQuotaPools(pool, identity.userId, await isInstanceAdmin(context.config, identity.userId)) });
    } catch (error) { return sendRouteError(reply, error); }
  });
}
