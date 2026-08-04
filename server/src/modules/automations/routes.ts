import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  dbPool,
  HttpError,
  jsonBody,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common";
import { AutomationService, automationToOut } from "./service";
import { PgAutomationRepository } from "./repository";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = () =>
    new AutomationService(context.config, new PgAutomationRepository(dbPool(context.config)));

  app.get("/api/v1/spaces/:spaceId/automations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const q = query(request);
      const rows = await new PgAutomationRepository(dbPool(context.config)).list(spaceId, {
        projectId: optionalString(q.project_id),
      });
      return reply.send(rows.map(automationToOut));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/spaces/:spaceId/automations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const row = await service().create({
        spaceId,
        ownerUserId: identity.userId,
        body: jsonBody(request),
      });
      return reply.code(201).send(automationToOut(row));
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

  app.put("/api/v1/spaces/:spaceId/automations/autonomy", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const row = await service().enableAutonomy({
        spaceId,
        actorUserId: identity.userId,
        body: jsonBody(request),
      });
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
      );
      if (!row) return reply.code(404).send({ detail: "Automation not found" });
      return reply.send(automationToOut(row));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/spaces/:spaceId/automations/:automationId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const row = await service().update({
        spaceId,
        automationId: params(request).automationId ?? "",
        actorUserId: identity.userId,
        body: jsonBody(request),
      });
      return reply.send(automationToOut(row));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/spaces/:spaceId/automations/:automationId/fire", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const body = jsonBody(request);
      const triggerType = optionalString(body.trigger_type);
      if (triggerType && triggerType !== "manual") {
        throw new HttpError(422, "Public automation fire only supports trigger_type='manual'");
      }
      const result = await service().fire({
        spaceId,
        automationId: params(request).automationId ?? "",
        actorUserId: identity.userId,
        prompt: optionalString(body.prompt),
        instruction: optionalString(body.instruction),
        triggerType: "manual",
      });
      return reply.send(result);
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
      return reply.send(await new PgAutomationRepository(dbPool(context.config)).listWorkflowExecutions(spaceId, params(request).automationId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
