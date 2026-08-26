import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, params, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { PgRouteDecisionRepository } from "./repository.js";
import { PgRunRepository } from "../runs/repository.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/runs/:runId/route-decision", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const db = dbPool(context.config);
      const runId = params(request).runId ?? "";
      const run = await new PgRunRepository(db).getVisibleRun(identity.spaceId, identity.userId, runId);
      if (!run) return reply.code(404).send({ detail: "Run not found" });
      const decision = await new PgRouteDecisionRepository(db).getDecision(identity.spaceId, runId);
      if (!decision) return reply.code(404).send({ detail: "Route decision not found" });
      return reply.send(decision);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
