import type {FastifyInstance} from 'fastify';
import {ProjectFolderIoStatusSchema} from '@rainver/protocol';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {dbPool,jsonBody,params,resolveIdentity,sendRouteError} from '../routeUtils/common.js';
import {assertProjectWriter} from '../projects/access.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {loadFolderIoIntent} from './ioIntentRepository.js';
import {PgProjectFolderRepository} from './repository.js';
import {resolveLocationWithHost} from './workspaceLocations.js';
export const PROJECT_FOLDER_IO_ROUTES=[
  ['POST','/api/v1/projects/:projectId/folders','project.folder.create'],
  ['POST','/api/v1/projects/:projectId/folders/scan','project.folder.scan'],
  ['POST','/api/v1/projects/:projectId/folders/:folderId/file/draft/save','project.folder.draft.save'],
  ['POST','/api/v1/projects/:projectId/folders/:folderId/file/revisions/restore-as-draft','project.folder.revision.restore'],
]as const;
export function registerProjectFolderIoRoutes(app:FastifyInstance,context:ModuleContext):void{
  for(const[method,url,id]of PROJECT_FOLDER_IO_ROUTES)app.route({method,url,config:{operation:id},async handler(request,reply){
    const requestId=resolveRequestId(request);reply.header('x-request-id',requestId).header('cache-control','private, no-store');
    const fail=(error:OperationError)=>reply.code(error.httpStatus).send(error.body(requestId));
    const identity=await introspectIdentity(context.config,request,reply);if(!identity.ok)return fail(identity.reason==='denied'?new OperationError(identity.statusCode===401?'authentication_required':'operation_not_found',identity.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
    let body:Record<string,unknown>;try{body=request.body===undefined?{}:jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
    const p=params(request),target={project_id:p.projectId,...(p.folderId?{folder_id:p.folderId}:{})};if(Object.keys(target).some(key=>Object.hasOwn(body,key)))return fail(new OperationError('operation_invalid_input',422));
    const key=request.headers['idempotency-key'],result=await(await operationRuntime(context.config)).execute(id,{...body,...target},sessionActor({spaceId:identity.spaceId,userId:identity.userId}),requestId,typeof key==='string'?key:undefined);return reply.code(result.http_status).send(result.body);
  }});
  app.get('/api/v1/projects/:projectId/folder-io/:intentId',async(request,reply)=>{
    reply.header('cache-control','private, no-store');const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{
      const p=params(request),db=dbPool(context.config),intent=await loadFolderIoIntent(db,p.intentId!,identity.spaceId);
      if(intent.project_id!==p.projectId||intent.user_id!==identity.userId)throw new OperationError('operation_not_found',404);
      await assertProjectWriter(db,identity.spaceId,intent.project_id,identity.userId,{allowArchived:true});
      if(intent.folder_id){
        await new PgProjectFolderRepository(db,context.config).writableFolderForIo(identity,intent.project_id,intent.folder_id);
        const location=await resolveLocationWithHost(db,identity.spaceId,intent.folder_id,intent.frozen_json.location!.id);
        if(location.execution_host_kind==='remote'&&location.host_owner_user_id!==identity.userId)throw new OperationError('operation_not_found',404);
      }
      const job=(await db.query<{status:string}>('SELECT status FROM jobs WHERE id=$1 AND space_id=$2',[intent.job_id,identity.spaceId])).rows[0];
      const stalled=!['succeeded','failed','needs_attention'].includes(intent.status)&&job&&['failed','cancelled'].includes(job.status);
      const result=ProjectFolderIoStatusSchema.safeParse({id:intent.id,space_id:intent.space_id,project_id:intent.project_id,folder_id:intent.folder_id,job_id:intent.job_id,kind:intent.kind,status:stalled?'needs_attention':intent.status,error:intent.error_code?{code:intent.error_code,metadata:intent.effect_json.error_metadata??{}}:stalled?{code:'folder_job_requires_attention',metadata:{}}:null,result:intent.result_json});
      if(!result.success)throw new OperationError('operation_invalid_output',500);return reply.send(result.data);
    }catch(error){if(error instanceof OperationError)return reply.code(error.httpStatus).send(error.body(resolveRequestId(request)));return sendRouteError(reply,error);}
  });
}
