/**
 * Notification/webhook egress routes.
 *
 * - GET  /api/v1/server/notifications/webhooks/policy
 * - POST /api/v1/server/notifications/webhooks/dispatch
 */

import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { resolveIdentity } from "../routeUtils/common.js";
import { dispatchWebhookRoute, notificationWebhookPolicy } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/server/notifications/webhooks/policy", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    return notificationWebhookPolicy(context.config);
  });
  app.post(
    "/api/v1/server/notifications/webhooks/dispatch",
    async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      return dispatchWebhookRoute(context.config, request, reply);
    },
  );
}
