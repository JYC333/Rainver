import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, optionalString, params, query, requiredString, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { LearningService } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerOperationAdapters(app,context.config,[{"method": "POST", "url": "/api/v1/learning/objectives", "operation": "learning.objective.create"}, {"method": "POST", "url": "/api/v1/learning/items", "operation": "learning.item.create"}, {"method": "POST", "url": "/api/v1/learning/items/:itemId/review", "operation": "learning.item.review", "params": {"itemId": "item_id"}}]);
  const learning = () => new LearningService(dbPool(context.config));

  // Global surface: no project scoping, optionally
  // filtered by ?project_id=. Project-contextual surfaces are the
  // /projects/:projectId/... routes below, which always scope to one Project.
  app.get("/api/v1/learning/objectives", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await learning().listObjectives(identity, { projectId: optionalString(query(request).project_id) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });



  app.get("/api/v1/learning/items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await learning().listItems(identity, { projectId: optionalString(q.project_id), objectiveId: optionalString(q.objective_id) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });





  app.get("/api/v1/projects/:projectId/learning-objectives", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await learning().listObjectives(identity, { projectId }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/learning-items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await learning().listItems(identity, { projectId, objectiveId: optionalString(query(request).objective_id) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
