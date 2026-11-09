import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {introspectIdentity} from '../auth/identity.js';
import {jsonBody,params} from '../routeUtils/common.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
export const PROJECT_MANAGEMENT_ROUTES=[
 ['PUT','/api/v1/projects/:projectId/public-summary','project.public_summary.save','projects'],
 ['POST','/api/v1/projects/:projectId/public-summary/publish','project.public_summary.publish','projects'],
 ['POST','/api/v1/projects/:projectId/public-summary/revoke','project.public_summary.revoke','projects'],
 ['PATCH','/api/v1/projects/:projectId','project.update','projects'],
 ['POST','/api/v1/projects/:projectId/archive','project.archive','projects'],
 ['POST','/api/v1/projects/:projectId/notebook-chat','project.notebook.chat','projectResearch'],
 ['PUT','/api/v1/projects/:projectId/focus-area','project.focus_area.set','focusAreas'],
 ['POST','/api/v1/projects/:projectId/review-sessions','project.review_session.open','projectReview'],
 ['POST','/api/v1/projects/:projectId/updates','project.update.report','projectWork'],
 ['POST','/api/v1/projects/:projectId/updates/:eventId/undo','project.update.undo','projectWork'],
 ['POST','/api/v1/projects','project.create','projects'],
 ['POST','/api/v1/projects/:projectId/members','project.member.add','projects'],
 ['DELETE','/api/v1/projects/:projectId/members/:userId','project.member.remove','projects'],
 ['POST','/api/v1/projects/:projectId/brief-versions','project.brief.create','projects'],
 ['POST','/api/v1/projects/:projectId/brief-versions/:versionId/submit-review','project.brief.submit_review','projects'],
 ['POST','/api/v1/projects/:projectId/brief-versions/:versionId/publish','project.brief.publish','projects'],
 ['POST','/api/v1/projects/:projectId/instruction-versions','project.instruction.create','projects'],
 ['POST','/api/v1/projects/:projectId/instruction-versions/:versionId/submit-review','project.instruction.submit_review','projects'],
 ['POST','/api/v1/projects/:projectId/instruction-versions/:versionId/publish','project.instruction.publish','projects'],
 ['PUT','/api/v1/projects/:projectId/attention/:sourceType/:sourceId/state','project.attention.set_state','projects'],
 ['POST','/api/v1/projects/:projectId/decision-cases','decision.case.create','decisions'],
 ['POST','/api/v1/projects/:projectId/decision-cases/:caseId/options','decision.option.add','decisions'],
 ['POST','/api/v1/projects/:projectId/decision-cases/:caseId/criteria','decision.criterion.add','decisions'],
 ['POST','/api/v1/projects/:projectId/decision-cases/:caseId/scores','decision.option.score','decisions'],
 ['POST','/api/v1/projects/:projectId/decision-cases/:caseId/decide','decision.case.decide','decisions'],
 ['POST','/api/v1/projects/:projectId/decision-cases/:caseId/commitments','decision.commitment.add','decisions'],
 ['POST','/api/v1/projects/:projectId/decision-cases/:caseId/commitments/:commitmentId/deliver','decision.commitment.deliver','decisions'],
] as const;
export function registerProjectManagementOperationRoutes(app:FastifyInstance,context:Pick<ModuleContext,'config'>,owner:typeof PROJECT_MANAGEMENT_ROUTES[number][3]){
 for(const [method,url,id,module] of PROJECT_MANAGEMENT_ROUTES){if(module!==owner)continue;
  app.route({method,url,config:{operation:id},async handler(request,reply){
   const requestId=resolveRequestId(request);reply.header('x-request-id',requestId).header('cache-control','private, no-store');
   const fail=(e:OperationError)=>reply.code(e.httpStatus).send(e.body(requestId));
   const identity=await introspectIdentity(context.config,request,reply);if(!identity.ok)return fail(identity.reason==='denied'?new OperationError(identity.statusCode===401?'authentication_required':'operation_not_found',identity.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true));
   let body:Record<string,unknown>;try{body=request.body===undefined?{}:jsonBody(request);}catch{return fail(new OperationError('operation_invalid_input',422));}
   const p=params(request),target:Record<string,unknown>={};
   for(const [param,field] of [['eventId','event_id'],['projectId','project_id'],['versionId','version_id'],['userId','user_id'],['caseId','case_id'],['commitmentId','commitment_id'],['sourceType','source_type'],['sourceId','source_id']] as const)if(p[param]!==undefined)target[field]=p[param];
   if(Object.keys(target).some(k=>Object.hasOwn(body,k)))return fail(new OperationError('operation_invalid_input',422));
   const key=request.headers['idempotency-key'],out=await(await operationRuntime(context.config)).execute(id,{...body,...target},sessionActor({spaceId:identity.spaceId,userId:identity.userId}),requestId,typeof key==='string'?key:undefined);
   return reply.code(out.http_status).send(out.body);
  }});
 }
}
