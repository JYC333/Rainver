import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../../config.js';
import {resolveRequestId} from '../../../gateway/requestContext.js';
import {introspectIdentity} from '../../auth/identity.js';
import {jsonBody} from '../../routeUtils/common.js';
import {OperationError,markedRefusal} from './errors.js';
import {sessionActor} from './actor.js';
import {operationRuntime} from './runtime.js';
import type {OperationResponse} from '@rainver/protocol';

/** One retained URL bound to one core operation. Path parameters (and named
 * query parameters) become explicit target fields; a body may not restate them.
 * `fixed` pins a product variant the URL itself names (for example a status). */
export interface OperationAdapterRoute {
  readonly method:'POST'|'PUT'|'PATCH'|'DELETE';
  readonly url:string;
  readonly operation:string;
  readonly params?:Readonly<Record<string,string>>;
  readonly query?:Readonly<Record<string,string>>;
  readonly fixed?:Readonly<Record<string,unknown>>;
  /** Target fields an existing body schema itself carries; accepted only when equal to the URL's. */
  readonly restated?:readonly string[];
  /** An explicit owner-provided step that must run before, never inside, the
   * operation transaction (for example provider-funded summary preparation).
   * It changes no state the operation authorizes; the operation rechecks everything. */
  readonly prepare?:(identity:{spaceId:string;userId:string},input:Record<string,unknown>)=>Promise<void>;
  /**
   * An owner's local step around the operation, outside its transaction (an
   * operation plugin's in-process effects: closed before a disable and
   * reopened or blocked once the outcome is known). It must call `run`
   * exactly once and return its response; it decides nothing the operation
   * authorizes, and the operation rechecks everything.
   */
  readonly around?:(identity:{spaceId:string;userId:string},input:Record<string,unknown>,run:()=>Promise<OperationResponse>)=>Promise<OperationResponse>;
}

/** Formal adapters only: identity, transport key and the typed operation envelope; no domain logic. */
export function registerOperationAdapters(app:FastifyInstance,config:ServerConfig,routes:readonly OperationAdapterRoute[]):void{
  for(const route of routes){
    app.route({method:route.method,url:route.url,config:{operation:route.operation},async handler(request,reply){
      const requestId=resolveRequestId(request);
      reply.header('x-request-id',requestId).header('cache-control','private, no-store');
      const fail=(e:OperationError)=>reply.code(e.httpStatus).send(e.body(requestId));
      const identity=await introspectIdentity(config,request,reply);
      if(!identity.ok)return fail(identity.reason==='denied'?new OperationError(identity.statusCode===401?'authentication_required':'operation_not_found',identity.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
      let body:Record<string,unknown>;
      try{body=request.body===undefined?{}:jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
      const target:Record<string,unknown>={};
      const params=(request.params??{}) as Record<string,string|undefined>;
      for(const [param,field] of Object.entries(route.params??{}))if(params[param]!==undefined)target[field]=params[param];
      const query=(request.query??{}) as Record<string,unknown>;
      for(const [name,field] of Object.entries(route.query??{})){const value=query[name];if(typeof value==='string'&&value.trim())target[field]=value.trim();}
      Object.assign(target,route.fixed??{});
      if(Object.keys(target).some(k=>Object.hasOwn(body,k)&&!(route.restated?.includes(k)&&body[k]===target[k])))return fail(new OperationError('operation_invalid_input',422));
      if(route.prepare){
        try{await route.prepare({spaceId:identity.spaceId,userId:identity.userId},{...body,...target});}
        catch(error){
          const status=(error as {statusCode?:number}).statusCode;
          const refusal=(error as {name?:string}).name==='RoomMutationError'?markedRefusal(error as Error&{statusCode:number;responseBody?:unknown},'rooms'):undefined;
          if(refusal)return reply.code(refusal.httpStatus).send(refusal.body(requestId));
          return fail(status===403||status===404?new OperationError('operation_not_found',404):new OperationError('operation_temporarily_unavailable',503,true));
        }
      }
      const key=request.headers['idempotency-key'];
      const input={...body,...target};
      const run=async()=>(await operationRuntime(config)).execute(route.operation,input,sessionActor({spaceId:identity.spaceId,userId:identity.userId}),requestId,typeof key==='string'?key:undefined);
      let out:OperationResponse;
      if(route.around){
        try{out=await route.around({spaceId:identity.spaceId,userId:identity.userId},input,run);}
        catch(error){
          const status=(error as {statusCode?:number}).statusCode;
          return fail(status===403||status===404?new OperationError('operation_not_found',404):new OperationError('operation_temporarily_unavailable',503,true));
        }
      }else out=await run();
      return reply.code(out.http_status).send(out.body);
    }});
  }
}
