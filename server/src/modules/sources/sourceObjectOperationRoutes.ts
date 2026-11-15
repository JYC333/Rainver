import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import type {ServerConfig} from '../../config.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {jsonBody,params} from '../routeUtils/common.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';

/** One retained POST URL whose body discriminator (`action` unless named)
 * already selected one of two policies; each policy is its own operation. The
 * path parameter becomes the named target field and may not be restated by the
 * body. The discriminator stays in the body, so each operation's strict schema
 * still refuses an unsupported value. */
export function registerActionSplitAdapter(app:FastifyInstance,config:ServerConfig,route:{url:string;param:string;field:string;operations:readonly [string,string];first:ReadonlySet<string>;discriminant?:string;successStatus?:number}){
  app.route({method:'POST',url:route.url,config:{operation:route.operations[1]},async handler(request,reply){
    const requestId=resolveRequestId(request);reply.header('x-request-id',requestId).header('cache-control','private, no-store');
    const fail=(e:OperationError)=>reply.code(e.httpStatus).send(e.body(requestId));
    const auth=await introspectIdentity(config,request,reply);
    if(!auth.ok)return fail(auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
    let body:Record<string,unknown>;
    try{body=jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
    if(Object.hasOwn(body,route.field))return fail(new OperationError('operation_invalid_input',422));
    const id=route.first.has(String(body[route.discriminant??'action']))?route.operations[0]:route.operations[1];
    const key=request.headers['idempotency-key'];
    const result=await(await operationRuntime(config)).execute(id,{...body,[route.field]:params(request)[route.param]},sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);
    return reply.code(result.http_status).send(result.body);
  }});
}

/** Retained Source item/evidence and post-processing URLs as formal core adapters. */
export function registerSourceObjectOperationRoutes(app:FastifyInstance,context:ModuleContext){
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/sources/items/manual-url',operation:'source.item.save_url'},
    {method:'PATCH',url:'/api/v1/sources/items/:itemId',operation:'source.item.update',params:{itemId:'source_item_id'}},
    {method:'POST',url:'/api/v1/sources/evidence',operation:'source.evidence.create'},
    {method:'PATCH',url:'/api/v1/sources/evidence/:evidenceId',operation:'source.evidence.update',params:{evidenceId:'evidence_id'}},
    {method:'POST',url:'/api/v1/sources/evidence-links',operation:'source.evidence.link'},
    {method:'POST',url:'/api/v1/sources/post-processing/run-once',operation:'source.processing.run_once'},
  ]);
  // Retention-widening queue requests versus the reader's own triage.
  registerActionSplitAdapter(app,context.config,{url:'/api/v1/sources/items/:itemId/actions',param:'itemId',field:'source_item_id',operations:['source.item.queue','source.item.triage'],first:new Set(['queue_content','archive_snapshot'])});
  // Content/evidence creation versus review of a post-processing decision.
  registerActionSplitAdapter(app,context.config,{url:'/api/v1/sources/post-processing/decisions/:decisionId/actions',param:'decisionId',field:'decision_id',operations:['source.processing.decision.queue','source.processing.decision.review'],first:new Set(['queue_content','extract_evidence'])});
}
