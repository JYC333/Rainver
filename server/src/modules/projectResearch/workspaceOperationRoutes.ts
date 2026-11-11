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
 ['POST','/api/v1/projects/:projectId/research/initial-intake/start','research.intake.start'],
 ['POST','/api/v1/projects/:projectId/research/workflow/:workflowId/trigger','research.workflow.trigger'],
 ['POST','/api/v1/projects/:projectId/research/workflow/:workflowId/history-backfill','research.workflow.history_backfill'],
 ['POST','/api/v1/projects/:projectId/research/question/resolve','research.question.resolve'],
 ['POST','/api/v1/projects/:projectId/research/question/apply-forward','research.question.resolve',{strategy:'apply_forward'}],
 ['POST','/api/v1/projects/:projectId/research/workflow/:workflowId/checkpoints/:checkpointId/decide','research.checkpoint.decide'],
 ['POST','/api/v1/projects/:projectId/research/operations/:operationId/retry','research.operation.retry'],
 ['POST','/api/v1/projects/:projectId/research/operations/:operationId/reconcile','research.operation.reconcile'],
 ['PUT','/api/v1/projects/:projectId/research/operations/:operationId/item-limit','research.operation.item_limit'],
 ['POST','/api/v1/projects/:projectId/research/operations/:operationId/rescan','research.operation.rescan'],
 ['POST','/api/v1/projects/:projectId/research/operations/:operationId/adopt-result','research.result.adopt'],
 ['POST','/api/v1/projects/:projectId/research/acquisitions','research.acquisition.start'],
 ['POST','/api/v1/projects/:projectId/research/standing/advice/:adviceId/action','research.standing.action'],
 ['POST','/api/v1/projects/:projectId/research/reports/:reportId/integrity','research.report.integrity'],
 ['POST','/api/v1/projects/:projectId/research/evidence-matrix/rebuild','project.corpus.backfill_sources'],
 ['POST','/api/v1/projects/:projectId/corpus/backfill-source-items','project.corpus.backfill_sources'],
 ['POST','/api/v1/projects/:projectId/research/question/refine','research.question.refine'],
] as const satisfies readonly (readonly [string,string,string,Record<string,unknown>?])[];
export function registerResearchWorkspaceOperationRoutes(app:FastifyInstance,context:ModuleContext){
 for(const [method,url,id,fixed] of RESEARCH_WORKSPACE_ROUTES as readonly (readonly [string,string,string,Record<string,unknown>?])[])app.route({method:method as 'POST',url,config:{operation:id},async handler(request,reply){
  const requestId=resolveRequestId(request);reply.header('x-request-id',requestId).header('cache-control','private, no-store');
  const fail=(e:OperationError)=>reply.code(e.httpStatus).send(e.body(requestId));
  const identity=await introspectIdentity(context.config,request,reply);if(!identity.ok)return fail(identity.reason==='denied'?new OperationError(identity.statusCode===401?'authentication_required':'operation_not_found',identity.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
  let body:Record<string,unknown>;try{body=request.body===undefined?{}:jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
  // Path params (camelCase) and adapter-fixed fields are authoritative; a body may not restate them.
  const target={...Object.fromEntries(Object.entries(params(request)).map(([k,v])=>[k.replace(/[A-Z]/g,c=>`_${c.toLowerCase()}`),v])),...fixed};
  if(Object.keys(target).some(k=>Object.hasOwn(body,k)))return fail(new OperationError('operation_invalid_input',422));
  const key=request.headers['idempotency-key'],out=await(await operationRuntime(context.config)).execute(id,{...body,...target},sessionActor({spaceId:identity.spaceId,userId:identity.userId}),requestId,typeof key==='string'?key:undefined);
  return reply.code(out.http_status).send(out.body);
 }});
}
