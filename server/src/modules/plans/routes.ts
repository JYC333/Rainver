import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, jsonBody, parsePage, params, resolveIdentity, sendRouteError, optionalString } from "../routeUtils/common.js";
import { requireSpaceOwnerOrAdmin } from "../routeUtils/access.js";
import { PgPlanRepository } from "./repository.js";
import { PlanExecutionService } from "./executionService.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new PgPlanRepository(dbPool(context.config));
  const execution = () => new PlanExecutionService(dbPool(context.config));

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

  app.post("/api/v1/plans/:planId/execute", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      return reply.code(202).send(await execution().execute(identity, params(request).planId ?? "", {
        agentId: optionalString(body.agent_id),
        prompt: optionalString(body.prompt),
        instruction: optionalString(body.instruction),
        runtimeProfileId: optionalString(body.runtime_profile_id),
        workflowInputJson: optionalObject(body.workflow_input_json),
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/plans/:planId/reconcile", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceOwnerOrAdmin(context.config, identity, reply, "Plan reconciliation requires space owner or admin role"))) return;
    try {
      return reply.send(await execution().reconcile(identity, params(request).planId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
