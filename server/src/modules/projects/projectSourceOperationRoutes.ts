import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {jsonBody,params} from '../routeUtils/common.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
export function registerProjectSourceOperationRoutes(app:FastifyInstance,context:ModuleContext){
  for(const [method,suffix,id] of [['POST','','project.source.bind'],['PATCH','/:bindingId','project.source.update'],['DELETE','/:bindingId','project.source.unbind'],['POST','/:bindingId/backfill','project.source.backfill']] as const){
    app.route({method,url:'/api/v1/projects/:projectId/sources/bindings'+suffix,config:{operation:id},handler:async(request,reply)=>{
      const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
      const auth=await introspectIdentity(context.config,request,reply);
      if(!auth.ok){const error=auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(error.httpStatus).send(error.body(requestId));}
      let body:Record<string,unknown>;
      try{body=request.body===undefined?{}:jsonBody(request);}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
      const path=params(request);
      // The old create helper sent the Project redundantly. Equal is canonical;
      // a conflicting body never changes the path authority.
      if(Object.hasOwn(body,'binding_id')||Object.hasOwn(body,'project_id')&&body.project_id!==path.projectId)return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));
      const {project_id:_project,...changes}=body;
      const input={project_id:path.projectId,...(path.bindingId?{binding_id:path.bindingId}:{}),...(id==='project.source.update'?{changes}:changes)};
      const key=request.headers['idempotency-key'];
      const result=await(await operationRuntime(context.config)).execute(id,input,sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);
      return reply.code(result.http_status).send(result.body);
    }});
  }
}
