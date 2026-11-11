/**
 * Notification/webhook egress routes.
 *
 * - GET  /api/v1/server/notifications/webhooks/policy
 * - POST /api/v1/server/notifications/webhooks/dispatch — `notification.webhook.dispatch`
 *   (`operations.ts`): a system command receipt; the delivery result is released by
 *   `GET /api/v1/system/commands/:commandId`.
 */

import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { resolveIdentity } from "../routeUtils/common.js";
import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import { notificationWebhookPolicy } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/server/notifications/webhooks/policy", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    return notificationWebhookPolicy(context.config);
  });
  registerOperationAdapters(app, context.config, [
    { method: "POST", url: "/api/v1/server/notifications/webhooks/dispatch", operation: "notification.webhook.dispatch" },
  ]);
}
