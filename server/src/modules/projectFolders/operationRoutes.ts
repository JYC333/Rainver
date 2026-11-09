import type { FastifyInstance } from 'fastify';
import type { ModuleContext } from '../../gateway/routeRegistry.js';
import { resolveRequestId } from '../../gateway/requestContext.js';
import { introspectIdentity } from '../auth/identity.js';
import { jsonBody, params } from '../routeUtils/common.js';
import { OperationError } from '../systemActions/operations/errors.js';
import { sessionActor } from '../systemActions/operations/actor.js';
import { operationRuntime } from '../systemActions/operations/runtime.js';
const base = '/api/v1/projects/:projectId/folders/:folderId';
export const PROJECT_FOLDER_OPERATION_ROUTES = [
  ['PUT', `${base}/file/draft`, 'project.folder.draft.upsert'],
  ['POST', `${base}/file/draft/rebase`, 'project.folder.draft.upsert'],
  ['POST', `${base}/file/draft/discard`, 'project.folder.draft.discard'],
  ['POST', `${base}/unregister`, 'project.folder.unregister'],
  ['PATCH', base, 'project.folder.update'],
  ['DELETE', base, 'project.folder.archive'],
  ['POST', `${base}/locations/:locationId/activate`, 'project.folder.location.activate'],
  ['POST', `${base}/execution-config`, 'project.folder.execution_config.create'],
  ['PATCH', `${base}/execution-config`, 'project.folder.execution_config.update'],
] as const;
function register(app: FastifyInstance, context: ModuleContext, configOnly: boolean): void {
  for(const [method,url,id] of PROJECT_FOLDER_OPERATION_ROUTES){
    if(id.includes('.execution_config.')!==configOnly)continue;
    app.route({method,url,config:{operation:id},async handler(request,reply){
      const requestId=resolveRequestId(request);reply.header('x-request-id',requestId).header('cache-control','private, no-store');
      const fail=(error:OperationError)=>reply.code(error.httpStatus).send(error.body(requestId));
      const identity=await introspectIdentity(context.config,request,reply);
      if(!identity.ok)return fail(identity.reason==='denied'?new OperationError(identity.statusCode===401?'authentication_required':'operation_not_found',identity.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
      let body:Record<string,unknown>;try{body=request.body===undefined?{}:jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
      const p=params(request),target={project_id:p.projectId,folder_id:p.folderId,...(p.locationId?{location_id:p.locationId}:{})};
      if(Object.keys(target).some(key=>Object.hasOwn(body,key)))return fail(new OperationError('operation_invalid_input',422));
      const key=request.headers['idempotency-key'],out=await(await operationRuntime(context.config)).execute(id,{...body,...target},sessionActor({spaceId:identity.spaceId,userId:identity.userId}),requestId,typeof key==='string'?key:undefined);
      return reply.code(out.http_status).send(out.body);
    }});
  }
}
export const registerProjectFolderOperationRoutes = (app:FastifyInstance,context:ModuleContext) => register(app,context,false);
export const registerProjectFolderConfigOperationRoutes = (app:FastifyInstance,context:ModuleContext) => register(app,context,true);
