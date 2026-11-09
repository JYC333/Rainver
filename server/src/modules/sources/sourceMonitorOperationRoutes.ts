import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {jsonBody,params} from '../routeUtils/common.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
export function registerSourceMonitorOperationRoutes(app:FastifyInstance,context:ModuleContext){
  for(const [method,url,id] of [['PATCH','/api/v1/sources/channels/:channelId','source.channel.update'],['POST','/api/v1/sources/channels/:channelId/scan','source.channel.scan']] as const)app.route({method,url,config:{operation:id},async handler(request,reply){
    const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
    const auth=await introspectIdentity(context.config,request,reply);
    if(!auth.ok){const error=auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(error.httpStatus).send(error.body(requestId));}
    let body:Record<string,unknown>;
    try{body=request.body===undefined?{}:jsonBody(request);}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    if(id==='source.channel.scan'&&Object.keys(body).length)return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));
    const key=request.headers['idempotency-key'];
    const input={source_channel_id:params(request).channelId,...(id==='source.channel.update'?{changes:body}:{})};
    const result=await(await operationRuntime(context.config)).execute(id,input,sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);
    return reply.code(result.http_status).send(result.body);
  }});
}
