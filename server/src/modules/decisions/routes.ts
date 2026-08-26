import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, jsonBody, params, query, requiredString, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { DecisionCaseService } from "./caseService.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const cases = () => new DecisionCaseService(dbPool(context.config));

  app.get("/api/v1/projects/:projectId/decision-cases", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await cases().listCases(identity, projectId, query(request).status));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/decision-cases", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await cases().createCase(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/decision-cases/:caseId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await cases().getCase(identity, requiredString(p.projectId, "project_id"), requiredString(p.caseId, "case_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/decision-cases/:caseId/options", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await cases().addOption(identity, requiredString(p.projectId, "project_id"), requiredString(p.caseId, "case_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/decision-cases/:caseId/criteria", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await cases().addCriterion(identity, requiredString(p.projectId, "project_id"), requiredString(p.caseId, "case_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/decision-cases/:caseId/scores", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await cases().scoreOption(identity, requiredString(p.projectId, "project_id"), requiredString(p.caseId, "case_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/decision-cases/:caseId/decide", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await cases().decide(identity, requiredString(p.projectId, "project_id"), requiredString(p.caseId, "case_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/decision-cases/:caseId/commitments", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await cases().addCommitment(identity, requiredString(p.projectId, "project_id"), requiredString(p.caseId, "case_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/decision-cases/:caseId/commitments/:commitmentId/deliver", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await cases().createDeliveryFromCommitment(
        identity,
        requiredString(p.projectId, "project_id"),
        requiredString(p.caseId, "case_id"),
        requiredString(p.commitmentId, "commitment_id"),
        jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
