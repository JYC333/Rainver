import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {registerSourceMonitorOperationRoutes} from './sourceMonitorOperationRoutes.js';
import {registerGmailRoutes} from './gmail/gmailRoutes.js';
import {registerSourceObjectOperationRoutes} from './sourceObjectOperationRoutes.js';
import {registerSourceRetrievalRoutes} from './retrievalOperations.js';
import {registerSourceSubscriptionOperationRoutes} from './sourceSubscriptionOperationRoutes.js';
import {registerBackfillOperationRoutes} from './sourceBackfillOperationRoutes.js';
import {registerDeepReadingRoutes} from './deepReading/routes.js';
import {registerMaterialProcessingRoutes} from './materialProcessing/routes.js';
import {registerSourceGoalRoutes} from './goals/routes.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  jsonBody,
  optionalString,
  parsePage,
  params,
  query,
  requiredString,
  resolveIdentity,
  sendRouteError,
  toDbDate,
} from "../routeUtils/common.js";
import { requireInstanceAdmin } from "../routeUtils/access.js";
import { enforceSources } from "./enforceSources.js";
import { PgSourcesRepository } from "./repository.js";
import { SourcePostProcessingService } from "./postProcessing/service.js";
import { registerCustomSourceRoutes } from "./customSources/customSourceRoutes.js";
import { registerSourceRecipeRoutes } from "./sourceRecipeRoutes.js";
import { listSourceRuns } from "./sourceRunReadModel.js";
import { SourceBackfillPlanningService } from "./sourceBackfillService.js";
import { SourceChannelService } from "./channels/sourceChannelService.js";
import { SourceProviderCatalogService } from "./catalog/sourceProviderCatalogService.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerSourceMonitorOperationRoutes(app,context);
  registerGmailRoutes(app,context);
  registerSourceObjectOperationRoutes(app,context);
  registerSourceRetrievalRoutes(app,context);
  registerBackfillOperationRoutes(app,context);
  registerSourceSubscriptionOperationRoutes(app,context);
  const repository = () => new PgSourcesRepository(dbPool(context.config), context.config);
  const backfills = () => new SourceBackfillPlanningService(dbPool(context.config), context.config);
  const channels = () => new SourceChannelService(dbPool(context.config), context.config);
  const catalog = () => new SourceProviderCatalogService(dbPool(context.config));

  app.get("/api/v1/sources/providers", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await catalog().listPublicProviders());
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post('/api/v1/sources/channels',{config:{operation:'source.channel.create'}},async(request,reply)=>{
    const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
    const auth=await introspectIdentity(context.config,request,reply);
    if(!auth.ok){const error=auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(error.httpStatus).send(error.body(requestId));}
    let body:Record<string,unknown>;try{body=jsonBody(request);}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    const key=request.headers['idempotency-key'];
    const result=await(await operationRuntime(context.config)).execute('source.channel.create',body,sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);
    return reply.code(result.http_status).send(result.body);
  });

  app.get("/api/v1/sources/channels", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await channels().list(identity, { status: optionalString(q.status), providerKey: optionalString(q.provider_key) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/followed", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await channels().listFollowed(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/recommendations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await channels().listRecommendations(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get("/api/v1/sources/channels/:channelId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const channel = await channels().get(identity, params(request).channelId ?? "");
      if (!channel) return reply.code(404).send({ detail: "Source channel not found" });
      return reply.send(channel);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // The instance admin's catalog switches (`sourceCatalogOperations.ts`), same URLs and bodies.
  registerOperationAdapters(app, context.config, [
    { method: "PATCH", url: "/api/v1/instance/source-catalog/providers/:providerId", operation: "source_catalog.provider.update", params: { providerId: "provider_id" } },
    { method: "PATCH", url: "/api/v1/instance/source-catalog/connectors/:connectorId", operation: "source_catalog.connector.update", params: { connectorId: "connector_id" } },
    { method: "PATCH", url: "/api/v1/instance/source-catalog/mappings/:mappingId", operation: "source_catalog.mapping.update", params: { mappingId: "mapping_id" } },
  ]);
  app.get("/api/v1/instance/source-catalog", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try {
      return reply.send(await catalog().listCatalog());
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/backfill/plans", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await backfills().list(identity, requiredString(params(request).channelId, "source_channel_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/backfill/plans/:planId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const gate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan", p.planId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await backfills().get(identity, requiredString(p.channelId, "source_channel_id"), requiredString(p.planId, "plan_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  const postProcessing = () => new SourcePostProcessingService(dbPool(context.config), context.config);
  registerCustomSourceRoutes(app, context);
  registerSourceRecipeRoutes(app, context);
  registerSourceGoalRoutes(app,context);registerMaterialProcessingRoutes(app,context);registerDeepReadingRoutes(app,context);

  app.get("/api/v1/sources", sourcesHealth(context));
  app.get("/api/v1/sources/", sourcesHealth(context));

  app.get("/api/v1/sources/channels/:channelId/source-runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await listSourceRuns(dbPool(context.config), identity, params(request).channelId ?? "", {
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/post-processing/rules", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await postProcessing().listRules(identity, params(request).channelId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/post-processing/rules",{config:{operation:'source.processing.rule.create'}},async(request,reply)=>{
    const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
    const auth=await introspectIdentity(context.config,request,reply);
    if(!auth.ok){const error=auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(error.httpStatus).send(error.body(requestId));}
    let body:Record<string,unknown>;try{body={source_channel_id:params(request).channelId,rule:jsonBody(request)};}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    const key=request.headers['idempotency-key'];const result=await(await operationRuntime(context.config)).execute('source.processing.rule.create',body,sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);return reply.code(result.http_status).send(result.body);
  });

  app.patch("/api/v1/sources/channels/:channelId/post-processing/rules/:ruleId",{config:{operation:'source.processing.rule.update'}},async(request,reply)=>{
    const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
    const auth=await introspectIdentity(context.config,request,reply);
    if(!auth.ok){const error=auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(error.httpStatus).send(error.body(requestId));}
    let body:Record<string,unknown>;try{body={source_channel_id:params(request).channelId,rule_id:params(request).ruleId,changes:jsonBody(request)};}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    const key=request.headers['idempotency-key'];const result=await(await operationRuntime(context.config)).execute('source.processing.rule.update',body,sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);return reply.code(result.http_status).send(result.body);
  });

  app.post("/api/v1/sources/channels/:channelId/post-processing/rules/:ruleId/run",{config:{operation:'source.processing.rule.dispatch'}},async(request,reply)=>{
    const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
    const auth=await introspectIdentity(context.config,request,reply);
    if(!auth.ok){const error=auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(error.httpStatus).send(error.body(requestId));}
    let body:Record<string,unknown>;try{if(Object.keys(jsonBody(request)).length)throw new Error('Unexpected body');body={source_channel_id:params(request).channelId,rule_id:params(request).ruleId,mode:'run'};}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    const key=request.headers['idempotency-key'];const result=await(await operationRuntime(context.config)).execute('source.processing.rule.dispatch',body,sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);return reply.code(result.http_status).send(result.body);
  });

  app.get("/api/v1/sources/channels/:channelId/post-processing/runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await postProcessing().listRuns(identity, params(request).channelId ?? "", limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/post-processing/backlog", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await postProcessing().backlog(identity, params(request).channelId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/post-processing/decisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await postProcessing().listDecisions(identity, {
        connectionId: params(request).channelId ?? "",
        ruleId: optionalString(q.rule_id),
        relevance: optionalString(q.relevance),
        reviewStatus: optionalString(q.review_status),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/post-processing/rules/:ruleId/drain",{config:{operation:'source.processing.rule.dispatch'}},async(request,reply)=>{
    const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
    const auth=await introspectIdentity(context.config,request,reply);
    if(!auth.ok){const error=auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(error.httpStatus).send(error.body(requestId));}
    let body:Record<string,unknown>;try{if(Object.keys(jsonBody(request)).length)throw new Error('Unexpected body');body={source_channel_id:params(request).channelId,rule_id:params(request).ruleId,mode:'drain'};}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    const key=request.headers['idempotency-key'];const result=await(await operationRuntime(context.config)).execute('source.processing.rule.dispatch',body,sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);return reply.code(result.http_status).send(result.body);
  });

  app.get("/api/v1/sources/post-processing/decisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await postProcessing().listDecisions(identity, {
        connectionId: optionalString(q.channel_id),
        projectId: optionalString(q.project_id),
        ruleId: optionalString(q.rule_id),
        relevance: optionalString(q.relevance),
        reviewStatus: optionalString(q.review_status),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/briefings", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await postProcessing().listBriefings(identity, {
        connectionId: optionalString(q.channel_id),
        projectId: optionalString(q.project_id),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/briefings/:channelId/:date", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await postProcessing().getBriefing(
        identity,
        params(request).channelId ?? "",
        params(request).date ?? "",
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listItems(identity, {
        libraryStatus: optionalString(q.library_status),
        readStatus: optionalString(q.read_status),
        contentState: optionalString(q.content_state),
        connectionId: optionalString(q.connection_id),
        itemType: optionalString(q.item_type),
        libraryType: optionalString(q.library_type),
        sourceDomain: optionalString(q.source_domain),
        createdAfter: toDbDate(q.created_after),
        occurredAfter: toDbDate(q.occurred_after),
        q: optionalString(q.q),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get("/api/v1/sources/items/:itemId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const item = await repository().getItem(identity, params(request).itemId ?? "");
      if (!item) return reply.code(404).send({ detail: "Source item not found" });
      return reply.send(item);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });



  app.get("/api/v1/sources/jobs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listJobs(identity, {
        status: optionalString(q.status),
        sourceItemId: optionalString(q.source_item_id),
        connectionId: optionalString(q.connection_id),
        jobType: optionalString(q.job_type),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/jobs/:jobId/run",{config:{operation:'source.extraction.dispatch'}},async(request,reply)=>{
    const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
    const auth=await introspectIdentity(context.config,request,reply);
    if(!auth.ok){const error=auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(error.httpStatus).send(error.body(requestId));}
    let body:Record<string,unknown>;try{if(Object.keys(jsonBody(request)).length)throw new Error('Unexpected body');body={extraction_job_id:params(request).jobId};}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    const key=request.headers['idempotency-key'];const result=await(await operationRuntime(context.config)).execute('source.extraction.dispatch',body,sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);return reply.code(result.http_status).send(result.body);
  });

  app.get("/api/v1/sources/evidence", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listEvidence(identity, {
        status: optionalString(q.status),
        evidenceType: optionalString(q.evidence_type),
        sourceItemId: optionalString(q.source_item_id),
        projectId: optionalString(q.project_id),
        connectionId: optionalString(q.connection_id),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get("/api/v1/sources/evidence/:evidenceId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const evidence = await repository().getEvidence(identity, params(request).evidenceId ?? "");
      if (!evidence) return reply.code(404).send({ detail: "Evidence not found" });
      return reply.send(evidence);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get("/api/v1/sources/evidence-links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 100);
      return reply.send(await repository().listEvidenceLinks(identity, {
        evidenceId: optionalString(q.evidence_id),
        targetType: optionalString(q.target_type),
        targetId: optionalString(q.target_id),
        status: optionalString(q.status),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get("/api/v1/sources/project-items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listProjectItems(identity, {
        projectId: requiredString(q.project_id, "project_id"),
        sourceChannelId: optionalString(q.source_channel_id),
        itemType: optionalString(q.item_type),
        sourceDomain: optionalString(q.source_domain),
        matchedDate: optionalString(q.matched_date),
        createdAfter: toDbDate(q.created_after),
        occurredAfter: toDbDate(q.occurred_after),
        q: optionalString(q.q),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/project-source-summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await repository().projectSourceSummary(identity, requiredString(q.project_id, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/source-health", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await repository().sourceHealth(identity, { channelId: optionalString(q.channel_id) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

}

function sourcesHealth(context: ModuleContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    return reply.send({ ok: true });
  };
}
