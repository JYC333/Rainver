import {registerProjectLiveUpdates} from './liveUpdates.js';
import {registerProjectSourceProposalOperationRoutes} from './sourceProposalOperationRoutes.js';
import {registerProjectCorpusOperationRoutes} from './corpusOperationRoutes.js';
import {registerProjectManagementOperationRoutes} from './managementOperationRoutes.js';
import {registerProjectSourceOperationRoutes} from './projectSourceOperationRoutes.js';
import { NO_STORE_CACHE_CONTROL } from '../../gateway/cacheControl.js';
import { introspectIdentity } from '../auth/identity.js';
import { resolveRequestId } from '../../gateway/requestContext.js';
import { operationRuntime } from '../systemActions/operations/runtime.js';
import { sessionActor } from '../systemActions/operations/actor.js';
import { OperationError } from '../systemActions/operations/errors.js';
import { registerMonitoringRoutes } from "./monitoring/routes.js";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  HttpError,
  jsonBody,
  requiredString,
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { projectReaders } from "./access.js";
import { ProjectCorpusRepository } from "./corpusRepository.js";
import { PgProjectRepository } from "./repository.js";
import { ProjectSourceBindingService } from "./projectSourceBindingService.js";
import { ProjectKernelService } from "./kernelService.js";
import { ProjectAttentionService, registerBuiltInAttentionAdapters } from "./attentionService.js";
import { ProjectOverviewService } from "./overviewService.js";
import { ProjectOperationService } from "./projectOperationService.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerProjectCorpusOperationRoutes(app,context);
  registerProjectSourceProposalOperationRoutes(app,context);
  registerProjectManagementOperationRoutes(app,context,'projects');
  registerProjectSourceOperationRoutes(app,context);
  registerMonitoringRoutes(app, context);
  registerProjectLiveUpdates(app,context);
  const repository = () => PgProjectRepository.fromConfig(context.config);
  const corpusRepository = () => new ProjectCorpusRepository(dbPool(context.config));
  const sourceBindings = () => new ProjectSourceBindingService(dbPool(context.config));
  const operations = () => new ProjectOperationService(dbPool(context.config));

  for (const [url, id] of [
    ['/api/v1/projects/:projectId/operations','project.operation.create'],
    ['/api/v1/projects/:projectId/operations/:operationId/cancel','project.operation.cancel'],
  ] as const) app.post(url, {config:{operation:id}}, async(request,reply)=>{
    const requestId=resolveRequestId(request);
    reply.header('cache-control',NO_STORE_CACHE_CONTROL);
    const resolved=await introspectIdentity(context.config,request,reply);
    if(!resolved.ok) {
      const error=resolved.reason==='denied'
        ? resolved.statusCode===401?new OperationError('authentication_required',401):new OperationError('operation_not_found',404)
        : new OperationError('operation_temporarily_unavailable',503,true);
      return reply.code(error.httpStatus).send(error.body(requestId));
    }
    let body:Record<string,unknown>;
    try { body=jsonBody(request); }
    catch { return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId)); }
    if(Object.hasOwn(body,'project_id') || Object.hasOwn(body,'operation_id'))
      return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));
    const p=params(request), input=id==='project.operation.create'
      ? {...body,project_id:p.projectId}
      : {...body,project_id:p.projectId,operation_id:p.operationId};
    const key=request.headers['idempotency-key'];
    const result=await(await operationRuntime(context.config)).execute(id,input,
      sessionActor({spaceId:resolved.spaceId,userId:resolved.userId}),requestId,typeof key==='string'?key:undefined);
    return reply.code(result.http_status).send(result.body);
  });

  app.get("/api/v1/projects/:projectId/operations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const q=query(request),limit=q.limit===undefined?100:Number(q.limit);
      const items=await operations().list(identity,requiredString(p.projectId,"project_id"),{limit,after_id:optionalString(q.after_id)??undefined});
      if(items.length===limit)reply.header("X-Next-Cursor",items[items.length-1]!.id);
      return reply.send(items);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/operations/:operationId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await operations().get(identity, requiredString(p.projectId, "project_id"), requiredString(p.operationId, "operation_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/sources/bindings", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const q = query(request);
      return reply.send(await sourceBindings().listBindings(identity, { projectId: requiredString(p.projectId, "project_id"), sourceChannelId: optionalString(q.source_channel_id) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/sources/extraction-profiles", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await sourceBindings().listExtractionProfiles(identity, requiredString(p.projectId, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/sources/health", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await sourceBindings().health(identity, requiredString(p.projectId, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });





  app.get("/api/v1/projects", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 50);
      const status = optionalString(q.status);
      if (status && !["active", "archived"].includes(status)) {
        return reply.code(422).send({ detail: "status must be active or archived" });
      }
      return reply.send(await repository().list(identity, { status, limit, offset }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/public-summaries", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 50);
      return reply.send(
        await repository().listPublicSummaries(identity, {
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });




  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const project = await repository().get(identity, params(request).projectId ?? "");
      if (!project) return reply.code(404).send({ detail: "Project not found" });
      return reply.send(project);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/public-summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const summary = await repository().getPublicSummary(identity, params(request).projectId ?? "");
      if (!summary) return reply.code(404).send({ detail: "Project public summary not found" });
      return reply.send(summary);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/public-summary/editor", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().getPublicSummaryEditorState(identity, params(request).projectId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });












  app.get("/api/v1/projects/:projectId/summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().summary(identity, params(request).projectId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/corpus", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 50);
      return reply.send(await corpusRepository().list(identity, params(request).projectId ?? "", {
        status: optionalString(q.status),
        triageStatus: optionalString(q.triage_status),
        readStatus: optionalString(q.read_status),
        role: optionalString(q.role),
        q: optionalString(q.q),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });






  // Project membership = the project-level memory access ACL. List is open to
  // any space member; add/remove require the project owner or a space owner/admin.
  app.get("/api/v1/projects/:projectId/members", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listMembers(identity, params(request).projectId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  /**
   * Everyone who can read this Project.
   *
   * Distinct from `/members`, which is the Project-level memory ACL and omits
   * the owner. This is the roster picker's candidate source: a Room's audience
   * is chosen from it, and offering anyone outside it produces an invitation
   * the server then refuses.
   *
   * The gate is the answer itself. A caller who is not among the readers
   * cannot read the Project, and so gets the same 404 a Project that does not
   * exist would give — no roster, and no signal that there was one.
   */
  app.get("/api/v1/projects/:projectId/readers", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = params(request).projectId ?? "";
      const readers = await projectReaders(dbPool(context.config), identity.spaceId, projectId);
      if (!readers.some((reader) => reader.user_id === identity.userId)) {
        throw new HttpError(404, "Project not found");
      }
      return reply.send({ readers });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Folder listing/creation/update/deletion all live in the projectFolders
  // module under this same `/api/v1/projects/:projectId/folders` path.

  registerBuiltInAttentionAdapters();
  const kernel = () => ProjectKernelService.fromConfig(context.config);
  const attention = () => ProjectAttentionService.fromConfig(context.config);
  const overview = () => ProjectOverviewService.fromConfig(context.config);

  app.get("/api/v1/projects/:projectId/brief-versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await kernel().listBriefVersions(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/brief-versions/active", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await kernel().getActiveBriefVersion(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/instruction-versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send(await kernel().listInstructionVersions(identity, requiredString(params(request).projectId, "project_id"))); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.get("/api/v1/projects/:projectId/instruction-versions/active", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send(await kernel().getActiveInstructionVersion(identity, requiredString(params(request).projectId, "project_id"))); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.get("/api/v1/projects/:projectId/attention", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await attention().listAttentionItems(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/overview", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await overview().getOverview(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
