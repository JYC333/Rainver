import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { dbPool, jsonBody, optionalString, params, query, requiredString, resolveIdentity, sendRouteError } from "../routeUtils/common";
import { LearningService } from "./service";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const learning = () => new LearningService(dbPool(context.config));

  // Global surface (plan section 13.5): no project scoping, optionally
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

  app.post("/api/v1/learning/objectives", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await learning().createObjective(identity, jsonBody(request)));
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

  app.post("/api/v1/learning/items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await learning().createItem(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/learning/items/:itemId/review", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const itemId = requiredString(params(request).itemId, "item_id");
      return reply.send(await learning().recordReview(identity, itemId, jsonBody(request)));
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
