import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/deployments/jobs", async (request, reply) => {
    try {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      return reply.send({ items: [] });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/deployments/jobs", async (request, reply) => {
    try {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      return reply.code(501).send({ detail: "deployment_jobs is not implemented" });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/deployments/jobs/:jobId", async (request, reply) => {
    try {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      return reply.code(501).send({ detail: "deployment_jobs is not implemented" });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
