import {admitStrategy} from './discovery/strategyAdmission.js';
import {ContentAccessAuditService} from '../contentAccess/audit.js';
import {readEvaluationResult} from './evaluationJob.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, resolveIdentity, sendRouteError, withQueryableTransaction, HttpError } from "../routeUtils/common.js";

import { assertProjectReadable } from "../projects/access.js";
import { ResearchQueryRepository } from "./queryPlanning/repository.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/research/query-strategies", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const db = dbPool(context.config);
      await assertProjectReadable(db, identity.spaceId, request.params.projectId, identity.userId);
      const result = await withQueryableTransaction(db,async tx=>{
        const result=await new ResearchQueryRepository(tx).listStrategies(identity.spaceId,request.params.projectId);
        const ids=result.strategies.map(r=>r.id).sort();
        if(ids.length){
          const closure=await admitStrategy(tx,context.config,sessionActor(identity),ids[0]!,[],[],'read',ids.slice(1));
          await new ContentAccessAuditService(tx).recordReads({spaceId:identity.spaceId,viewerUserId:identity.userId,resourceType:'source_connection',resourceIds:closure.parents.map(r=>r.id),accessType:'read',reason:'Research strategy result read'});
        }
        const current=await new ResearchQueryRepository(tx).listStrategies(identity.spaceId,request.params.projectId);
        if(current.strategies.map(r=>r.id).sort().join()!==ids.join())throw new HttpError(409,'Research strategies changed; read again');
        return current;
      });
      return reply.send(protocol.ListResearchQueryStrategiesResponseSchema.parse({
        active_strategy_ids: result.activeStrategyIds,
        strategies: result.strategies,
      }));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.get<{ Params: { strategyId: string; providerKey: string } }>("/api/v1/research/query-strategies/:strategyId/providers/:providerKey/attempts", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const query = protocol.ListResearchQueryAttemptsQuerySchema.parse(request.query ?? {});
      const providerKey = protocol.ResearchProviderKeySchema.parse(request.params.providerKey);
      const db = dbPool(context.config);
      await assertProjectReadable(db, identity.spaceId, query.project_id, identity.userId);
      const page=await withQueryableTransaction(db,async tx=>{
        const closure=await admitStrategy(tx,context.config,sessionActor(identity),request.params.strategyId,[],[],'read');
        if(closure.strategy.project_id!==query.project_id)return {items:[],total:0};
        await new ContentAccessAuditService(tx).recordReads({spaceId:identity.spaceId,viewerUserId:identity.userId,resourceType:'source_connection',resourceIds:closure.parents.map(r=>r.id),accessType:'read',reason:'Research strategy attempt read'});
        return new ResearchQueryRepository(tx).listAttempts(identity.spaceId,query.project_id,request.params.strategyId,providerKey,{limit:query.limit,offset:query.offset});
      });
      return reply.send(protocol.ListResearchQueryAttemptsResponseSchema.parse({ ...page, limit: query.limit, offset: query.offset }));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.get<{Params:{jobId:string}}>('/api/v1/research/query-evaluations/:jobId',async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{reply.header('cache-control','private, no-store');return reply.send(await readEvaluationResult(dbPool(context.config),context.config,sessionActor(identity),protocol.ResearchQueryEvaluationAcceptedJobSchema.shape.job_id.parse(request.params.jobId)));}
    catch(error){if((error as {statusCode?:number}).statusCode===403)return reply.code(404).send({detail:'Research evaluation unavailable'});return sendRouteError(reply,error);}
  });
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/research/query-strategies/evaluate',operation:'research.strategy.evaluate'},
    {method:'POST',url:'/api/v1/research/query-strategies/:strategyId/providers/:providerKey/retry',operation:'research.strategy.retry',params:{strategyId:'strategy_id',providerKey:'provider_key'}},
    {method:'POST',url:'/api/v1/research/query-strategies/:strategyId/materialize',operation:'research.strategy.materialize',params:{strategyId:'strategy_id'}},
    {method:'POST',url:'/api/v1/research/query-strategies/:strategyId/activate',operation:'research.strategy.activate',params:{strategyId:'strategy_id'}},
  ]);
}
