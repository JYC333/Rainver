import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  jsonBody,
  numberValue,
  params,
  requiredString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { ProjectReviewSessionService } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.post("/api/v1/projects/:projectId/review-sessions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const limit = numberValue(jsonBody(request).limit) ?? 5;
      return reply.code(201).send(await new ProjectReviewSessionService(dbPool(context.config)).open(identity, projectId, limit));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
