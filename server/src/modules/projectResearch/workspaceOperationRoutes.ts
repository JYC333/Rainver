import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {jsonBody,params} from '../routeUtils/common.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
export const RESEARCH_WORKSPACE_ROUTES=[
 ['POST','/api/v1/projects/:projectId/research/reports','research.report.snapshot'],
 ['POST','/api/v1/projects/:projectId/research/ask-ai','research.ask_ai'],
 ['POST','/api/v1/projects/:projectId/research/question/assessment/confirm','research.question.assessment.confirm'],
 ['PUT','/api/v1/projects/:projectId/research/initial-intake','research.intake.draft'],
 ['POST','/api/v1/projects/:projectId/research/workflow/:workflowId/stages/:stageKey/run','research.workflow.stage.record'],
 ['PUT','/api/v1/projects/:projectId/research/item-limit','research.intake.limit'],
 ['POST','/api/v1/projects/:projectId/research/standing/advice/:adviceId/dismiss','research.standing.dismiss'],
 ['POST','/api/v1/projects/:projectId/research/standing/batches/:batchId/retry','research.standing.retry'],
 ['POST','/api/v1/projects/:projectId/research/area','research.area.initialize'],
 ['PUT','/api/v1/projects/:projectId/research/reading-list/:sourceItemId/card','research.evidence_card.update'],
 ['POST','/api/v1/projects/:projectId/research/checklist','research.checklist.create'],
 ['PATCH','/api/v1/projects/:projectId/research/checklist/:itemId','research.checklist.update'],
 ['DELETE','/api/v1/projects/:projectId/research/checklist/:itemId','research.checklist.delete'],
 ['POST','/api/v1/projects/:projectId/research/claims','research.claim.link'],
 ['PATCH','/api/v1/projects/:projectId/research/claims/:claimLinkId','research.claim.update'],
 ['PUT','/api/v1/projects/:projectId/research/screening-criteria','research.screening.configure'],
] as const;
export function registerResearchWorkspaceOperationRoutes(app:FastifyInstance,context:ModuleContext){
 for(const [method,url,id] of RESEARCH_WORKSPACE_ROUTES)app.route({method,url,config:{operation:id},async handler(request,reply){
  const requestId=resolveRequestId(request);reply.header('x-request-id',requestId).header('cache-control','private, no-store');
  const fail=(e:OperationError)=>reply.code(e.httpStatus).send(e.body(requestId));
  const identity=await introspectIdentity(context.config,request,reply);if(!identity.ok)return fail(identity.reason==='denied'?new OperationError(identity.statusCode===401?'authentication_required':'operation_not_found',identity.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
  let body:Record<string,unknown>;try{body=request.body===undefined?{}:jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
  const p=params(request),target={project_id:p.projectId,...(p.workflowId?{workflow_id:p.workflowId}:{}),...(p.stageKey?{stage_key:p.stageKey}:{}),...(p.adviceId?{advice_id:p.adviceId}:{}),...(p.batchId?{batch_id:p.batchId}:{}),...(p.sourceItemId?{source_item_id:p.sourceItemId}:{}),...(p.itemId?{item_id:p.itemId}:{}),...(p.claimLinkId?{claim_link_id:p.claimLinkId}:{})};
  if(Object.keys(target).some(k=>Object.hasOwn(body,k)))return fail(new OperationError('operation_invalid_input',422));
  const key=request.headers['idempotency-key'],out=await(await operationRuntime(context.config)).execute(id,{...body,...target},sessionActor({spaceId:identity.spaceId,userId:identity.userId}),requestId,typeof key==='string'?key:undefined);
  return reply.code(out.http_status).send(out.body);
 }});
}
