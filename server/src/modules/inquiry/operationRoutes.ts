import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {jsonBody,params} from '../routeUtils/common.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
const root='/api/v1/projects/:projectId/inquiry';
export const INQUIRY_OPERATION_ROUTES=[
 ['POST',`${root}/relations`,'inquiry.relation.add'],['DELETE',`${root}/relations/:relationId`,'inquiry.relation.remove'],
 ['PUT',`${root}/threads/:threadId/primary-parent`,'inquiry.thread.set_primary_parent'],['POST',`${root}/threads/:threadId/notes`,'inquiry.note.link'],['DELETE',`${root}/threads/:threadId/notes/:noteObjectId`,'inquiry.note.unlink'],
 ['PUT',`${root}/threads/:threadId/personal-focus`,'inquiry.personal_focus.set'],['PUT',`${root}/settings/shared-focus-wip-limit`,'inquiry.shared_focus.configure'],
 ['POST',`${root}/threads/:threadId/definition-revisions`,'inquiry.definition.revise'],['POST',`${root}/threads/:threadId/iterations`,'inquiry.iteration.record'],['PATCH',`${root}/threads/:threadId/work-state`,'inquiry.work.update'],['POST',`${root}/threads/:threadId/lifecycle-transitions`,'inquiry.lifecycle.transition'],
 ['POST',`${root}/threads/:threadId/problem/work`,'inquiry.problem.record_work'],['POST',`${root}/threads/:threadId/problem/close-round`,'inquiry.problem.close_round'],['POST',`${root}/threads/:threadId/tasks`,'inquiry.task.link'],['POST',`${root}/threads/:threadId/tasks/:taskId/reference-result`,'inquiry.task.reference_result'],
 ['POST',`${root}/threads/:threadId/signals`,'inquiry.signal.create'],['POST',`${root}/candidates/:candidateId/decision`,'inquiry.candidate.decide'],['POST',`${root}/candidates/:candidateId/reopen`,'inquiry.candidate.reopen'],['POST',`${root}/review-packets`,'inquiry.review_packet.open'],['POST',`${root}/review-packets/:packetId/close`,'inquiry.review_packet.close'],['POST',`${root}/delta-briefs`,'inquiry.delta_brief.generate'],
] as const;
const locators={projectId:'project_id',threadId:'thread_id',relationId:'relation_id',noteObjectId:'note_object_id',taskId:'task_id',candidateId:'candidate_id',packetId:'packet_id'} as const;
export function registerInquiryOperationRoutes(app:FastifyInstance,context:ModuleContext){
 for(const [method,url,id] of INQUIRY_OPERATION_ROUTES)app.route({method,url,config:{operation:id},async handler(request,reply){
  const requestId=resolveRequestId(request);reply.header('x-request-id',requestId).header('cache-control','private, no-store');const fail=(e:OperationError)=>reply.code(e.httpStatus).send(e.body(requestId));
  const identity=await introspectIdentity(context.config,request,reply);if(!identity.ok)return fail(identity.reason==='denied'?new OperationError(identity.statusCode===401?'authentication_required':'operation_not_found',identity.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
  let body:Record<string,unknown>;try{body=request.body===undefined?{}:jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
  const p=params(request),target:Record<string,string>={};for(const [param,field] of Object.entries(locators))if(p[param])target[field]=p[param]!;
  if(Object.keys(target).some(field=>Object.hasOwn(body,field)))return fail(new OperationError('operation_invalid_input',422));
  const key=request.headers['idempotency-key'],result=await(await operationRuntime(context.config)).execute(id,{...body,...target},sessionActor({spaceId:identity.spaceId,userId:identity.userId}),requestId,typeof key==='string'?key:undefined);return reply.code(result.http_status).send(result.body);
 }});
}
