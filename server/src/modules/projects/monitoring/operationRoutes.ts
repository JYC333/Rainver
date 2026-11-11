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
 ['POST','/api/v1/projects/:projectId/information-monitoring/source-setup','project.monitoring.source.setup'],
 ['POST','/api/v1/projects/:projectId/information-monitoring/proposals','project.monitoring.proposal.create'],
 ['POST','/api/v1/projects/:projectId/information-monitoring/reconcile','project.monitoring.reconcile'],
 ['POST','/api/v1/projects/:projectId/information-monitoring/runs','project.monitoring.run.start'],
 ['POST','/api/v1/projects/:projectId/information-monitoring/items/:itemId/feedback','project.monitoring.feedback'],
 ['POST','/api/v1/projects/:projectId/sources/propose-bind','project.source.bind.propose'],
 ['POST','/api/v1/projects/:projectId/sources/propose-setup','project.source.setup.propose'],
 ['POST','/api/v1/projects/public-summaries/feedback','project.summary.feedback'],
 ['POST','/api/v1/projects/:projectId/public-summary/draft','project.public_summary.draft.generate'],
 ['POST','/api/v1/projects/retrieval/brief','project.summary.brief.request'],
] as const;
export function registerProjectIngressOperationRoutes(app:FastifyInstance,context:ModuleContext){registerOperationAdapterRoutes(app,context,PROJECT_INGRESS_ROUTES);}
/** Formal session adapters: path params are authoritative targets and the core owns the command. */
export function registerOperationAdapterRoutes(app:FastifyInstance,context:ModuleContext,routes:readonly (readonly [string,string,string])[]){
 for(const [method,url,id] of routes)app.route({method:method as 'POST',url,config:{operation:id},async handler(request,reply){
  const requestId=resolveRequestId(request);reply.header('x-request-id',requestId).header('cache-control','private, no-store');
  const fail=(e:OperationError)=>reply.code(e.httpStatus).send(e.body(requestId));
  const identity=await introspectIdentity(context.config,request,reply);if(!identity.ok)return fail(identity.reason==='denied'?new OperationError(identity.statusCode===401?'authentication_required':'operation_not_found',identity.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
  let body:Record<string,unknown>;try{body=request.body===undefined?{}:jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
  // Path params are authoritative targets; a body may not restate them.
  const target=Object.fromEntries(Object.entries(params(request)).map(([k,v])=>[k.replace(/[A-Z]/g,c=>`_${c.toLowerCase()}`),v]));
  if(Object.keys(target).some(k=>Object.hasOwn(body,k)))return fail(new OperationError('operation_invalid_input',422));
  const key=request.headers['idempotency-key'],result=await(await operationRuntime(context.config)).execute(id,{...body,...target},sessionActor({spaceId:identity.spaceId,userId:identity.userId}),requestId,typeof key==='string'?key:undefined);
  return reply.code(result.http_status).send(result.body);
 }});
}
