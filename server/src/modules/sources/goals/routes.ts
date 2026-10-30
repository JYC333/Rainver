import {requestGoalCheck} from './collectionQueue.js';
import {readBindingReconfirmation,confirmBindingSource} from './reconfirm.js';
import {nativeSearchAvailability} from './nativeSafety.js';
import {SourceGoalConversation} from './conversation.js';
import {findLegacyGoal,mapLegacyGoal,rollbackGoalCompatibility} from './compatibility.js';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {dbPool,jsonBody,params,resolveIdentity,sendRouteError,HttpError} from '../../routeUtils/common.js';
import {SourceGoalCreateSchema,SourceGoalBeginRequestSchema,SourceGoalMessageRequestSchema,SourceGoalLegacyRequestSchema,SourceGoalCompatibilityRollbackSchema,SourceGoalBindingConfirmRequestSchema} from '@rainver/protocol';
import {resolveContentCreationContext} from '../../access/creationContext.js';
import {enforceSources} from '../enforceSources.js';
import {SourceGoalService} from './service.js';
import {SourceGoalExecutor} from './execution.js';
import {SourceGoalRepairService} from './repair.js';
import {queueSourceGoalAgent} from './agent.js';
export function registerSourceGoalRoutes(app:FastifyInstance,context:ModuleContext){
 const db=()=>dbPool(context.config);const executor=()=>new SourceGoalExecutor(db(),context.config);const service=()=>new SourceGoalService(db(),context.config,executor());
 app.get('/api/v1/sources/goal-setup/agent-search/:profileId',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;return reply.send(await nativeSearchAvailability(db(),identity,String(params(req).profileId)));});
 app.get('/api/v1/sources/goal-setup/begin/:creationKey',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{const query=(req.query??{}) as {project_id?:unknown};const key=String(params(req).creationKey);if(!key||key.length>128)throw new HttpError(422,'Invalid creation key');return reply.send(await new SourceGoalConversation(db(),context.config).findCreation(identity,key,typeof query.project_id==='string'&&query.project_id?query.project_id:null));}catch(error){return sendRouteError(reply,error);}});
 app.get('/api/v1/sources/goal-setup/legacy/:channelId',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(await findLegacyGoal(db(),context.config,identity,String(params(req).channelId)));}catch(error){return sendRouteError(reply,error);}});
 for(const action of ['begin','legacy','message','compatibility_rollback'] as const)app.post(`/api/v1/sources/goal-setup/${action}`,async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{const body=jsonBody(req);const gateScope=action==='begin'?await resolveContentCreationContext(db(),{userId:identity.userId,requestSpaceId:identity.spaceId,projectId:typeof body.project_id==='string'?body.project_id:null}):{spaceId:identity.spaceId};const gate=await enforceSources(context,{...identity,spaceId:gateScope.spaceId},'source.goal.manage','source_goal',typeof body.goal_id==='string'?body.goal_id:undefined);if(gate.blocked)return reply.code(403).send(gate.reply403);const conversation=new SourceGoalConversation(db(),context.config);if(action==='begin')return reply.send(await conversation.begin(identity,SourceGoalBeginRequestSchema.parse(body)));if(action==='legacy'){const input=SourceGoalLegacyRequestSchema.parse(body);return reply.send(await mapLegacyGoal(db(),identity,input.channel_id,input.dry_run===true));}if(action==='compatibility_rollback'){const input=SourceGoalCompatibilityRollbackSchema.parse(body);return reply.send(await rollbackGoalCompatibility(db(),identity,input.goal_id));}return reply.send(await conversation.send(identity,String(body.goal_id),SourceGoalMessageRequestSchema.parse(body)));}catch(error){return sendRouteError(reply,error);}});
 app.post('/api/v1/sources/goals',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{const input=SourceGoalCreateSchema.parse(jsonBody(req));const scope=await resolveContentCreationContext(db(),{userId:identity.userId,requestSpaceId:identity.spaceId,projectId:input.project_id});const gate=await enforceSources(context,{...identity,spaceId:scope.spaceId},'source.goal.manage','source_goal');if(gate.blocked)return reply.code(403).send(gate.reply403);return reply.code(201).send(await service().create(identity,jsonBody(req)));}catch(error){return sendRouteError(reply,error);}
 });
 app.post('/api/v1/sources/goals/:goalId/repairs/:repairId/publish',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{const id=String(params(req).goalId);const gate=await enforceSources(context,identity,'source.goal.manage','source_goal',id);if(gate.blocked)return reply.code(403).send(gate.reply403);return reply.send(await new SourceGoalRepairService(db(),context.config,executor()).publish(identity,id,String(params(req).repairId),false));}catch(error){return sendRouteError(reply,error);}});
 app.get('/api/v1/sources/goals',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(await service().list(identity));}catch(error){return sendRouteError(reply,error);}});
 app.get('/api/v1/sources/goals/:goalId',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(await service().read(identity,String(params(req).goalId)));}catch(error){return sendRouteError(reply,error);}});
 // A binding stopped because its Source changed: what changed, and the owner's exact confirmation (reconfirm.ts).
 app.get('/api/v1/sources/goals/:goalId/bindings/:bindingId/source-confirmation',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(await readBindingReconfirmation(db(),context.config,identity,String(params(req).goalId),String(params(req).bindingId)));}catch(error){return sendRouteError(reply,error);}});
 app.post('/api/v1/sources/goals/:goalId/bindings/:bindingId/source-confirmation',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{const id=String(params(req).goalId);const gate=await enforceSources(context,identity,'source.goal.manage','source_goal',id);if(gate.blocked)return reply.code(403).send(gate.reply403);const input=SourceGoalBindingConfirmRequestSchema.parse(jsonBody(req));return reply.send(await confirmBindingSource(db(),context.config,identity,id,String(params(req).bindingId),input));}catch(error){return sendRouteError(reply,error);}});
 for(const action of ['explore','preview','save','follow','feedback','check','resume','pause','delete','rollback'] as const)app.post(`/api/v1/sources/goals/:goalId/${action}`,async(req,reply)=>{
  const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{
   const id=String(params(req).goalId),body=jsonBody(req);const gate=await enforceSources(context,identity,'source.goal.manage','source_goal',id);if(gate.blocked)return reply.code(403).send(gate.reply403);
   if(action==='check')return reply.send(await requestGoalCheck(db(),context.config,identity,id,body));
   if(action==='explore')return reply.send(await queueSourceGoalAgent(db(),context.config,identity,id,'explore'));
   if(action==='preview'){const disconnected=new AbortController();const close=()=>{if(!reply.raw.writableEnded)disconnected.abort();};reply.raw.once('close',close);try{return reply.send(await service().preview(identity,id,String(body.version_id),AbortSignal.any([disconnected.signal,AbortSignal.timeout(120000)])));}finally{reply.raw.off('close',close);}}
   if(action==='resume')return reply.send(await service().resume(identity,id,String(body.version_id)));
   if(action==='save')return reply.send(await service().saveSample(identity,id,body));
   if(action==='follow')return reply.send(await service().follow(identity,id,body));
   if(action==='feedback')return reply.send(await service().feedback(identity,id,body));
   if(action==='pause' || action==='delete')return reply.send(await service().stop(identity,id,action==='delete'));
   if(!Number.isSafeInteger(body.expected_revision))throw new HttpError(422,'Expected revision required');
   return reply.send(await new SourceGoalRepairService(db(),context.config,executor()).rollback(identity,id,String(body.binding_id),Number(body.expected_revision)));
  }catch(error){return sendRouteError(reply,error);}
 });
}
