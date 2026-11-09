import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../../gateway/requestContext.js';
import {introspectIdentity} from '../../auth/identity.js';
import {jsonBody,params} from '../../routeUtils/common.js';
import {OperationError} from '../../systemActions/operations/errors.js';
import {sessionActor} from '../../systemActions/operations/actor.js';
import {operationRuntime} from '../../systemActions/operations/runtime.js';
export const PROJECT_INGRESS_ROUTES=[
 ['PATCH','/api/v1/projects/:projectId/information-monitoring/details','project.monitoring.details.update'],
 ['PATCH','/api/v1/projects/:projectId/information-monitoring/state','project.monitoring.state.update'],
] as const;
export function registerProjectIngressOperationRoutes(app:FastifyInstance,context:ModuleContext){
 for(const [method,url,id] of PROJECT_INGRESS_ROUTES)app.route({method,url,config:{operation:id},async handler(request,reply){
  const requestId=resolveRequestId(request);reply.header('x-request-id',requestId).header('cache-control','private, no-store');
  const fail=(e:OperationError)=>reply.code(e.httpStatus).send(e.body(requestId));
  const identity=await introspectIdentity(context.config,request,reply);if(!identity.ok)return fail(identity.reason==='denied'?new OperationError(identity.statusCode===401?'authentication_required':'operation_not_found',identity.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
  let body:Record<string,unknown>;try{body=jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
  if(Object.hasOwn(body,'project_id'))return fail(new OperationError('operation_invalid_input',422));
  const key=request.headers['idempotency-key'],result=await(await operationRuntime(context.config)).execute(id,{...body,project_id:params(request).projectId},sessionActor({spaceId:identity.spaceId,userId:identity.userId}),requestId,typeof key==='string'?key:undefined);
  return reply.code(result.http_status).send(result.body);
 }});
}
