import {readBindingReconfirmation} from './reconfirm.js';
import {nativeSearchAvailability} from './nativeSafety.js';
import {SourceGoalConversation} from './conversation.js';
import {findLegacyGoal} from './compatibility.js';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {dbPool,params,resolveIdentity,sendRouteError,HttpError} from '../../routeUtils/common.js';
import {registerOperationAdapters} from '../../systemActions/operations/routeAdapter.js';
import {SourceGoalService} from './service.js';
import {SourceGoalExecutor} from './execution.js';
export function registerSourceGoalRoutes(app:FastifyInstance,context:ModuleContext){
 const db=()=>dbPool(context.config);const executor=()=>new SourceGoalExecutor(db(),context.config);const service=()=>new SourceGoalService(db(),context.config,executor());
 app.get('/api/v1/sources/goal-setup/agent-search/:profileId',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;return reply.send(await nativeSearchAvailability(db(),identity,String(params(req).profileId)));});
 app.get('/api/v1/sources/goal-setup/begin/:creationKey',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{const query=(req.query??{}) as {project_id?:unknown};const key=String(params(req).creationKey);if(!key||key.length>128)throw new HttpError(422,'Invalid creation key');return reply.send(await new SourceGoalConversation(db(),context.config).findCreation(identity,key,typeof query.project_id==='string'&&query.project_id?query.project_id:null));}catch(error){return sendRouteError(reply,error);}});
 app.get('/api/v1/sources/goal-setup/legacy/:channelId',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(await findLegacyGoal(db(),context.config,identity,String(params(req).channelId)));}catch(error){return sendRouteError(reply,error);}});
 app.get('/api/v1/sources/goals',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(await service().list(identity));}catch(error){return sendRouteError(reply,error);}});
 app.get('/api/v1/sources/goals/:goalId',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(await service().read(identity,String(params(req).goalId)));}catch(error){return sendRouteError(reply,error);}});
 // A binding stopped because its Source changed: what changed, and the owner's exact confirmation (reconfirm.ts).
 app.get('/api/v1/sources/goals/:goalId/bindings/:bindingId/source-confirmation',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(await readBindingReconfirmation(db(),context.config,identity,String(params(req).goalId),String(params(req).bindingId)));}catch(error){return sendRouteError(reply,error);}});
 // Retained command URLs: formal adapters onto the core Goal operations (operations.ts).
 const goal={goalId:'goal_id'} as const;
 registerOperationAdapters(app,context.config,[
  {method:'POST',url:'/api/v1/sources/goal-setup/begin',operation:'source.goal.setup.begin'},
  {method:'POST',url:'/api/v1/sources/goal-setup/message',operation:'source.goal.setup.message'},
  {method:'POST',url:'/api/v1/sources/goal-setup/legacy',operation:'source.goal.setup.legacy'},
  {method:'POST',url:'/api/v1/sources/goal-setup/compatibility_rollback',operation:'source.goal.setup.compatibility_rollback'},
  {method:'POST',url:'/api/v1/sources/goals',operation:'source.goal.create'},
  {method:'POST',url:'/api/v1/sources/goals/:goalId/repairs/:repairId/publish',operation:'source.goal.repair.publish',params:{...goal,repairId:'repair_id'}},
  {method:'POST',url:'/api/v1/sources/goals/:goalId/bindings/:bindingId/source-confirmation',operation:'source.goal.binding.confirm_source',params:{...goal,bindingId:'binding_id'}},
  ...(['edit','explore','save','follow','feedback','check','resume','pause','delete'] as const).map(action=>({method:'POST' as const,url:`/api/v1/sources/goals/:goalId/${action}`,operation:`source.goal.${action}`,params:goal})),
  {method:'POST',url:'/api/v1/sources/goals/:goalId/preview',operation:'source.goal.preview.request',params:goal},
  {method:'POST',url:'/api/v1/sources/goals/:goalId/rollback',operation:'source.goal.binding.rollback',params:goal},
 ]);
}
