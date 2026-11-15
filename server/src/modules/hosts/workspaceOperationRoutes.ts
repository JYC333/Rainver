import {DAEMON_WORKSPACE_OPERATION_SCHEMAS} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
import {jsonBody} from '../routeUtils/common.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {daemonWorkspaceActor} from './workspaceActor.js';
export function registerDaemonWorkspaceOperations(app:FastifyInstance,config:ServerConfig):void{
 for(const [method,url,operation] of [
  ['POST','/api/v1/hosts/me/workspaces','host.workspace.create'],
  ['DELETE','/api/v1/hosts/me/workspaces/:folderId','host.workspace.remove'],
 ] as const){
  app.route({method,url,config:{operation},async handler(request,reply){
   const requestId=resolveRequestId(request);
   reply.header('x-request-id',requestId).header('cache-control','private, no-store');
   try{
    if(!config.databaseUrl)throw new OperationError('operation_temporarily_unavailable',503,true);
    const token=request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if(!token)throw new OperationError('authentication_required',401);
    const key=request.headers['idempotency-key'];
    let body:Record<string,unknown>;
    try{body=request.body===undefined?{}:jsonBody(request);}catch{throw new OperationError('operation_invalid_input',422);}
    if(method==='DELETE'&&Object.keys(body).length)throw new OperationError('operation_invalid_input',422);
    const input=method==='POST'?body:{location_id:(request.params as {folderId:string}).folderId};
    const parsed=DAEMON_WORKSPACE_OPERATION_SCHEMAS[operation].input.safeParse(input);
    if(!parsed.success)throw new OperationError('operation_invalid_input',422);
    const actor=await daemonWorkspaceActor(getDbPool(config.databaseUrl),token,operation,parsed.data,typeof key==='string'?key:undefined);
    const out=await(await operationRuntime(config)).execute(operation,parsed.data,actor,requestId,typeof key==='string'?key:undefined);
    return reply.code(out.http_status).send(out.body);
   }catch(error){const e=error instanceof OperationError?error:new OperationError('operation_temporarily_unavailable',503,true);return reply.code(e.httpStatus).send(e.body(requestId));}
  }});
 }
}
