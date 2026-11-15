import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, parsePage, params, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import { PgPlanRepository } from "./repository.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new PgPlanRepository(dbPool(context.config), context.config);

  app.get("/api/v1/plans", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const page = parsePage(request.query as Record<string, string | undefined>, 50);
      return reply.send(await repository().listPlans(identity, page.limit, page.offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/plans/:planId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const plan = await repository().getPlan(identity, params(request).planId ?? "");
      if (!plan) return reply.code(404).send({ detail: "Plan not found" });
      return reply.send(plan);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Formal adapters over the Plan owner's commands; no domain logic here.
  registerOperationAdapters(app, context.config, [
    { method: "POST", url: "/api/v1/plans/:planId/execute", operation: "plan.execute", params: { planId: "plan_id" } },
    { method: "POST", url: "/api/v1/plans/:planId/reconcile", operation: "plan.reconcile", params: { planId: "plan_id" } },
  ]);
}
