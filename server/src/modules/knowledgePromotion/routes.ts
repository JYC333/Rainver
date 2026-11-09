import {registerKnowledgeReviewRoutes} from './reviewOperationRoutes.js';
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, params, query, requiredString, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { KnowledgePromotionCandidateService } from "./candidateService.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerKnowledgeReviewRoutes(app,context,'candidate');
  const candidates = () => new KnowledgePromotionCandidateService(dbPool(context.config));

  app.get("/api/v1/projects/:projectId/knowledge-candidate-review-packets/:packetId",async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{const p=params(request);return reply.header('cache-control','private, no-store').send(await candidates().getReviewPacket(identity,requiredString(p.projectId,'project_id'),requiredString(p.packetId,'packet_id')));}catch(error){return sendRouteError(reply,error);}
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










}
