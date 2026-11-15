import {registerAutomationFireResultRoute} from './fireRequests.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { AutomationService, automationToOut } from "./service.js";
import { PgAutomationRepository } from "./repository.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = () =>
    new AutomationService(context.config, new PgAutomationRepository(dbPool(context.config)));
  registerAutomationFireResultRoute(app,context);
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/spaces/:spaceId/automations/:automationId/fire',spaceParam:'spaceId',operation:'automation.fire',params:{automationId:'automation_id'}},
    {method:'POST',url:'/api/v1/spaces/:spaceId/automations',spaceParam:'spaceId',operation:'automation.create'},
    {method:'PATCH',url:'/api/v1/spaces/:spaceId/automations/:automationId',spaceParam:'spaceId',operation:'automation.update',params:{automationId:'automation_id'}},
    {method:'PUT',url:'/api/v1/spaces/:spaceId/automations/autonomy',spaceParam:'spaceId',operation:'automation.autonomy.configure'},
  ]);

  app.get("/api/v1/spaces/:spaceId/automations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const q = query(request);
      const rows = await new PgAutomationRepository(dbPool(context.config)).list(spaceId, {
        projectId: optionalString(q.project_id),
        readableBy: identity.userId,
        includeOpsView: true,
      });
      return reply.send(rows.map(automationToOut));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Self-service Always-on: any active Space member manages only their own
  // autonomous_tick Automation here, never another member's. Registered
  // before the parametric :automationId routes below for readability, though
  // Fastify's router already prefers this static segment over a parametric
  // match regardless of registration order.
  app.get("/api/v1/spaces/:spaceId/automations/autonomy", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const row = await service().getOwnAutonomyAutomation({ spaceId, actorUserId: identity.userId });
      if (!row) return reply.code(404).send({ detail: "Always-on is not enabled" });
      return reply.send(automationToOut(row));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/spaces/:spaceId/automations/:automationId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const row = await new PgAutomationRepository(dbPool(context.config)).get(
        spaceId,
        params(request).automationId ?? "",
        { readableBy: identity.userId, includeOpsView: true },
      );
      if (!row) return reply.code(404).send({ detail: "Automation not found" });
      return reply.send(automationToOut(row));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/spaces/:spaceId/automations/:automationId/workflow-executions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      return reply.send(await new PgAutomationRepository(dbPool(context.config)).listWorkflowExecutions(
        spaceId,
        params(request).automationId ?? "",
        { readableBy: identity.userId },
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
