import {registerProblemResearchRoutes} from "./problemWorkspaceRoutes.js";
import { ResearchProblemResultService } from "./researchProblemResults.js";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { HttpError, dbPool, jsonBody, optionalString, params, query, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { ProjectResearchRepository } from "./repository.js";
import { ProjectResearchPipelineService } from "./pipeline/researchPipelineService.js";
import { ProjectResearchReportRepository } from "./reportRepository.js";
import { ProjectResearchQuestionRefineService } from "./questionRefineService.js";
import { registerProjectResearchAreaRoutes } from "./areaRoutes.js";
import { ProjectResearchStandingComparisonService } from "./standingComparisonService.js";
import { operationRuntime } from '../systemActions/operations/runtime.js';
import { sessionActor } from '../systemActions/operations/actor.js';
import { assertProjectWriter } from '../projects/access.js';
import { resolveRequestId } from '../../gateway/requestContext.js';
import { randomUUID } from 'node:crypto';

let repositoryFactoryOverride: ((context: ModuleContext) => ProjectResearchRepository) | null = null;
let orchestratorFactoryOverride: ((context: ModuleContext) => ProjectResearchPipelineService) | null = null;

export function __setProjectResearchRepositoryFactoryForTests(
  factory: ((context: ModuleContext) => ProjectResearchRepository) | null,
): void {
  repositoryFactoryOverride = factory;
}

export function __setProjectResearchOrchestratorFactoryForTests(
  factory: ((context: ModuleContext) => ProjectResearchPipelineService) | null,
): void {
  orchestratorFactoryOverride = factory;
}

function repository(context: ModuleContext): ProjectResearchRepository {
  if (repositoryFactoryOverride) return repositoryFactoryOverride(context);
  return new ProjectResearchRepository(dbPool(context.config));
}

function orchestrator(context: ModuleContext): ProjectResearchPipelineService {
  if (orchestratorFactoryOverride) return orchestratorFactoryOverride(context);
  return new ProjectResearchPipelineService(dbPool(context.config), context.config);
}

function requireParam(request: Parameters<typeof params>[0], name: string): string {
  const value = params(request)[name];
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerProblemResearchRoutes(app,context);
  const base = "/api/v1/projects/:projectId/research";
  app.get(`${base}/operations/:operationId/result`,async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{return reply.send(await new ResearchProblemResultService(dbPool(context.config)).read(identity,requireParam(request,"projectId"),requireParam(request,"operationId")));}catch(error){return sendRouteError(reply,error);}
  });
  const reports = () => new ProjectResearchReportRepository(dbPool(context.config));
  registerProjectResearchAreaRoutes(app, context, base, "/api/v1/projects/:projectId");

  app.get(`${base}/standing`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await new ProjectResearchStandingComparisonService(dbPool(context.config), context.config)
        .status(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });






  // Assessment routes are server-owned and rebuilt with this module by the dev polling watcher.
  app.get(`${base}/question/assessment`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const threadId = optionalString(query(request).thread_id);
      if (!threadId) throw new HttpError(422, "thread_id is required");
      return reply.send(await new ProjectResearchQuestionRefineService(dbPool(context.config), context.config)
        .getConversation(identity, requireParam(request, "projectId"), threadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get(`${base}/question/assessment/confirmations`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const threadId = optionalString(query(request).thread_id);
      if (!threadId) throw new HttpError(422, "thread_id is required");
      return reply.send(await new ProjectResearchQuestionRefineService(dbPool(context.config), context.config)
        .listConfirmations(identity, requireParam(request, "projectId"), threadId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });









  app.get(`${base}/question/impact`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const workflowId = optionalString(query(request).workflow_id);
      if (!workflowId) throw new HttpError(422, "workflow_id is required");
      return reply.send(await orchestrator(context).questionChangeImpact(identity, requireParam(request, "projectId"), workflowId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });



  app.get(`${base}/workflow`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).listWorkflows(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/scan-summaries`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const rawLimit = Number(query(request).limit ?? 30);
      return reply.send(await repository(context).listScanSummaries(
        identity,
        requireParam(request, "projectId"),
        Number.isFinite(rawLimit) ? rawLimit : 30,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });




  app.post(`${base}/operations/:operationId/cancel`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const operationId = requireParam(request, "operationId"), projectId = requireParam(request,"projectId");
      // Retain legacy 403/404 and error shape. The core repeats live authority checks.
      await assertProjectWriter(dbPool(context.config),identity.spaceId,projectId,identity.userId);
      const reason=optionalString(jsonBody(request).reason)?.trim() || undefined;
      const key=request.headers['idempotency-key'];
      const result=await (await operationRuntime(context.config)).execute('research.cancel_acquisition',
        {operation_id:operationId,project_id:projectId,...(reason?{reason}:{})},sessionActor(identity),resolveRequestId(request),typeof key==='string'?key:randomUUID());
      if('data' in result.body) return reply.code(result.http_status).send(result.body.data);
      if('error' in result.body) throw new HttpError(result.http_status,result.body.error.code==='operation_not_found'?'Research operation not found':result.body.error.code==='operation_invalid_input'?'reason must be at most 2000 characters':result.body.error.message);
      throw new HttpError(503,'Cancellation unavailable');
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });






  app.get(`${base}/workflow/:workflowId/checkpoints`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository(context).listCheckpoints(identity, requireParam(request, "projectId"), requireParam(request, "workflowId")),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get(`${base}/reports`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send(await reports().list(identity, requireParam(request, "projectId"))); }
    catch (error) { return sendRouteError(reply, error); }
  });
  app.get(`${base}/reports/:reportId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send(await reports().get(identity, requireParam(request, "projectId"), requireParam(request, "reportId"))); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.get(`${base}/claims`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(
        await repository(context).listClaimLinks(identity, requireParam(request, "projectId"), optionalString(q.workflow_id)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });





  app.get(`${base}/screening-criteria`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).getScreeningCriteria(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });



  app.get(`${base}/evidence-matrix`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).getEvidenceMatrix(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });



}
