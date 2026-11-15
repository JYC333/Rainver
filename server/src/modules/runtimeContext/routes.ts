import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  params,
  requiredString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { WorkContextService } from "./workContextService.js";
import { registerRuntimeContextPreviewRoutes } from "./previewRequests.js";
import { registerRuntimeContextOperationRoutes } from "./operations.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const workContexts = () => new WorkContextService(dbPool(context.config));
  registerRuntimeContextOperationRoutes(app, context.config);

  app.get("/api/v1/runtime-context/work-contexts/:scopeId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const active = await workContexts().getActive(
        identity,
        requiredString(params(request).scopeId, "scope_id"),
      );
      if (!active) return reply.send(null);
      return reply.send(protocol.WorkContextSetupSchema.parse(active));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/runtime-context/work-contexts/:scopeId/retrieval", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const state = await workContexts().getRetrievalSwitch(identity, requiredString(params(request).scopeId, "scope_id"));
      return reply.send(protocol.WorkRetrievalSwitchSchema.parse(state));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // One knowledge retrieval switch per Room Conversation, independent of recipients.
  app.get("/api/v1/runtime-context/room-conversations/:sessionId/retrieval", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(protocol.WorkRetrievalSwitchSchema.parse(await workContexts().getRoomConversationRetrievalSwitch(
        identity,
        requiredString(params(request).sessionId, "session_id"),
      )));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  registerRuntimeContextPreviewRoutes(app, context);

}
