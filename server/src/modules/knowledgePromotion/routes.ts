import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, jsonBody, numberValue, params, query, requiredString, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { KnowledgePromotionCandidateService } from "./candidateService.js";
import { KnowledgeExtractionService } from "./extractionService.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const candidates = () => new KnowledgePromotionCandidateService(dbPool(context.config));
  const extraction = () => new KnowledgeExtractionService(dbPool(context.config));

  app.post("/api/v1/projects/:projectId/knowledge-candidate-extractions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(202).send(await extraction().queue(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/knowledge-candidates", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await candidates().listCandidates(identity, projectId, query(request).status));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/knowledge-candidates-review-summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await candidates().getReviewSummary(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/knowledge-candidate-review-packets", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await candidates().openReviewPacket(
        identity, projectId, numberValue(jsonBody(request).limit) ?? undefined,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/knowledge-candidate-review-packets/:packetId/close", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await candidates().closeReviewPacket(
        identity, requiredString(p.projectId, "project_id"), requiredString(p.packetId, "packet_id"),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/knowledge-candidates/:candidateId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await candidates().getCandidate(identity, requiredString(p.projectId, "project_id"), requiredString(p.candidateId, "candidate_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/knowledge-candidates/from-note", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await candidates().createFromNote(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/knowledge-candidates/from-thread", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await candidates().createFromThread(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/knowledge-candidates/from-interpretation", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await candidates().createFromInterpretation(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/knowledge-candidates/:candidateId/decision", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await candidates().decideCandidate(
        identity, requiredString(p.projectId, "project_id"), requiredString(p.candidateId, "candidate_id"), jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/knowledge-candidates/:candidateId/reopen", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await candidates().reopenCandidate(
        identity, requiredString(p.projectId, "project_id"), requiredString(p.candidateId, "candidate_id"),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
