import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {jsonBody,params} from '../routeUtils/common.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';

/** These retained URLs are thin core adapters, not separate policy/writers. */
export function registerBackfillOperationRoutes(app:FastifyInstance,context:ModuleContext){
  const base='/api/v1/sources/channels/:channelId/backfill/plans';
  for(const [suffix,id] of [
    ['/preview','source.backfill.preview'],['','source.backfill.create_plan'],
    ['/:planId/pause','source.backfill.pause'],['/:planId/resume','source.backfill.resume'],
  ] as const)app.post(base+suffix,{config:{operation:id}},async(request,reply)=>{
    const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
    const resolved=await introspectIdentity(context.config,request,reply);
    if(!resolved.ok){
      const error=resolved.reason==='denied'?new OperationError(resolved.statusCode===401?'authentication_required':'operation_not_found',resolved.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);
      return reply.code(error.httpStatus).send(error.body(requestId));
    }
    let body:Record<string,unknown>;
    try{body=request.body===undefined?{}:jsonBody(request);}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    if(Object.hasOwn(body,'source_channel_id')||Object.hasOwn(body,'source_backfill_plan_id'))return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));
    const path=params(request),key=request.headers['idempotency-key'];
    const result=await(await operationRuntime(context.config)).execute(id,{...body,source_channel_id:path.channelId,...(path.planId?{source_backfill_plan_id:path.planId}:{})},
      sessionActor({spaceId:resolved.spaceId,userId:resolved.userId}),requestId,typeof key==='string'?key:undefined);
    return reply.code(result.http_status).send(result.body);
  });
}
