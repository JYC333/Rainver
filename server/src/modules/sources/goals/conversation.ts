import {requireNativeCollector} from './nativeSafety.js';
import {isDeepStrictEqual} from 'node:util';
import type {RuntimeSessionConfigSelection,SourceGoalBeginRequest} from '@rainver/protocol';
import {createHash} from 'node:crypto';
import {PgConversationBackendRepository} from '../../sessions/conversationBackendRepository.js';
import {validateSessionConfig} from '../../sessions/sessionConfig.js';
import {sourceGoalError} from './dispatchError.js';
import {goalDispatchErrorCode} from './dispatchError.js';
import {assertSafeGoalMessage} from './messageSafety.js';
import {resolveContentCreationContext} from '../../access/creationContext.js';
import {SourceGoalBudgetSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {PgSessionRepository} from '../../sessions/repository.js';
import {SourceGoalService} from './service.js';
import {SourceGoalExecutor} from './execution.js';
import {requireGoal} from './access.js';
import {queueSourceGoalAgent} from './agent.js';
/** Thin domain adapter to canonical Sessions/messages and Agent Runs. No chat store. */
export class SourceGoalConversation {
 constructor(readonly db:Pool,readonly config:ServerConfig){}
 /** Topic creation. With `follow` the topic, its explicit model/mode choices
  * and its one follow confirmation commit in a single transaction, so a lost
  * response or closed page never leaves an unconfirmed draft behind; a replay
  * with the same key and payload returns that topic and never charges another
  * planning attempt (the queued planning Run is reused). */
 async begin(identity:SpaceUserIdentity,input:SourceGoalBeginRequest){
  assertSafeGoalMessage(input.intent);
  const scope=await resolveContentCreationContext(this.db,{userId:identity.userId,requestSpaceId:identity.spaceId,projectId:input.project_id});
  // A replayed creation keeps the Agent/Profile it was confirmed with, even if
  // the owner's default changed since; an explicit choice is always honored.
  const existing=input.idempotency_key?(await this.db.query<{agent_id:string;runtime_profile_id:string}>('SELECT agent_id,runtime_profile_id FROM source_goals WHERE space_id=$1 AND owner_user_id=$2 AND creation_key=$3',[scope.spaceId,identity.userId,input.idempotency_key])).rows[0]:undefined;
  const selected=input.agent_id&&input.runtime_profile_id?{rows:[{id:input.agent_id,profile_id:input.runtime_profile_id}]}:existing?{rows:[{id:existing.agent_id,profile_id:existing.runtime_profile_id}]}:await this.db.query(`SELECT a.id,p.id AS profile_id FROM agents a JOIN agent_runtime_profiles p ON p.agent_id=a.id AND p.space_id=a.space_id WHERE a.space_id=$1 AND a.owner_user_id=$2 AND a.status='active' AND p.enabled=true ORDER BY (a.agent_kind='system_assistant') DESC,p.is_default DESC,a.created_at,p.id LIMIT 1`,[scope.spaceId,identity.userId]);
  const agent=selected.rows[0];if(!agent)throw sourceGoalError(409,'source_goal_execution_setup_required');
  if((input.search_path??'agent')==='agent')await requireNativeCollector(this.db,agent.profile_id);
  const fingerprint=createHash('sha256').update(JSON.stringify({search_path:input.search_path??'agent',session_config:input.session_config??null,follow:input.follow??null})).digest('hex');
  let created!:Awaited<ReturnType<SourceGoalService['create']>>;let followed:Awaited<ReturnType<SourceGoalService['followLocked']>>|null=null;
  await withDbTransaction(this.db,async tx=>{
   const service=new SourceGoalService(tx as unknown as Pool,this.config,new SourceGoalExecutor(this.db,this.config));
   created=await service.create({...identity,spaceId:scope.spaceId},{intent:input.intent,project_id:scope.projectId,creation_key:input.idempotency_key,agent_id:agent.id,runtime_profile_id:agent.profile_id,budget:SourceGoalBudgetSchema.parse({})});
   await tx.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[created.id]);
   const g=(await tx.query<{compatibility_json:Record<string,unknown>|null;session_id:string|null;project_id:string|null;agent_id:string;intent_json:{intent:string}}>('SELECT compatibility_json,session_id,project_id,agent_id,intent_json FROM source_goals WHERE id=$1',[created.id])).rows[0];
   const prior=g.compatibility_json?.creation_fingerprint;
   if(typeof prior==='string'){if(prior!==fingerprint)throw sourceGoalError(409,'source_goal_creation_key_changed');}
   else{
    await tx.query(`UPDATE source_goals SET compatibility_json=COALESCE(compatibility_json,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[created.id,{...(g.compatibility_json?.search_path?{}:{search_path:input.search_path??'agent'}),...(input.idempotency_key?{creation_fingerprint:fingerprint}:{})}]);
    // Explicit model/mode choices are validated against the Profile's current
    // catalog and saved on the topic's canonical Session before any Run exists.
    if(input.session_config!==undefined){
     const sessions=new PgSessionRepository(tx);const session=await sessions.createSession(created.space_id,identity.userId,{projectId:g.project_id,title:g.intent_json.intent.slice(0,120),metadata:{source_goal_id:created.id}});
     await tx.query('UPDATE source_goals SET session_id=$2 WHERE id=$1',[created.id,session.id]);
     const backends=new PgConversationBackendRepository(tx);const backend=await backends.resolveBinding({space_id:created.space_id,user_id:identity.userId,session_id:session.id,agent_id:agent.id,requested:{runtime_profile_id:agent.profile_id}});
     await backends.saveSessionConfig(created.space_id,session.id,agent.id,validateSessionConfig(input.session_config,backend.session_config_options??[]));
    }
   }
   if(input.follow)followed=await service.followLocked(tx,{...identity,spaceId:scope.spaceId},created.id,{idempotency_key:`begin:${input.idempotency_key}`,...input.follow});
  });
  if(followed)await new SourceGoalService(this.db,this.config,new SourceGoalExecutor(this.db,this.config)).afterFollow({...identity,spaceId:scope.spaceId},created.id,followed);
  return {...created,...(followed?{follow:(followed as {follow:unknown}).follow}:{})};
 }
 /** Owner-only lookup of a creation by its idempotency key, so a client whose
  * confirmation response was lost can open the committed topic without
  * keeping the topic text. Absence means nothing was committed. */
 async findCreation(identity:SpaceUserIdentity,key:string,projectId:string|null){
  try{
   const row=(await this.db.query<{id:string;space_id:string}>(`SELECT id,space_id FROM source_goals WHERE space_id=$1 AND owner_user_id=$2 AND creation_key=$3 AND project_id IS NOT DISTINCT FROM $4::varchar AND status<>'deleted'`,[identity.spaceId,identity.userId,key,projectId])).rows[0];
   if(!row)return {goal_id:null};
   await requireGoal(this.db,identity,row.id);
   return {goal_id:row.id,space_id:row.space_id};
  }catch(error){
   if(error instanceof HttpError&&[403,404].includes(error.statusCode))return {goal_id:null};
   throw error;
  }
 }
 async send(identity:SpaceUserIdentity,id:string,input:{search_path?:'agent'|'api';content:string;idempotency_key:string;session_config?:RuntimeSessionConfigSelection[];agent_id?:string;runtime_profile_id?:string}){
  if(!input.content?.trim() || input.content.length>8000 || !input.idempotency_key || input.idempotency_key.length>128)throw new HttpError(422,'Invalid goal message');
  assertSafeGoalMessage(input.content);
  const message=await withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true);
   if(input.agent_id&&input.runtime_profile_id){
    if(g.agent_id&&g.runtime_profile_id&&(g.agent_id!==input.agent_id||g.runtime_profile_id!==input.runtime_profile_id))throw new HttpError(409,'Goal execution selection is already bound');
    const selected=await db.query(`SELECT 1 FROM agents a JOIN agent_runtime_profiles p ON p.agent_id=a.id AND p.space_id=a.space_id WHERE a.id=$1 AND a.space_id=$2 AND a.owner_user_id=$3 AND a.status='active' AND p.id=$4 AND p.enabled=true`,[input.agent_id,g.space_id,identity.userId,input.runtime_profile_id]);
    if(!selected.rows[0])throw new HttpError(403,'Owned enabled Agent/Profile required');
    g.agent_id=input.agent_id;g.runtime_profile_id=input.runtime_profile_id;await db.query('UPDATE source_goals SET agent_id=$2,runtime_profile_id=$3 WHERE id=$1',[id,g.agent_id,g.runtime_profile_id]);
   }
   if(!g.agent_id || !g.runtime_profile_id){const p=await db.query<{id:string;profile_id:string}>(`SELECT a.id,p.id AS profile_id FROM agents a JOIN agent_runtime_profiles p ON p.agent_id=a.id AND p.space_id=a.space_id WHERE a.space_id=$1 AND a.owner_user_id=$2 AND a.status='active' AND p.enabled=true ORDER BY (a.agent_kind='system_assistant') DESC,p.is_default DESC,a.created_at LIMIT 1`,[g.space_id,g.owner_user_id]);if(!p.rows[0])throw sourceGoalError(409,'source_goal_execution_setup_required');g.agent_id=p.rows[0].id;g.runtime_profile_id=p.rows[0].profile_id;await db.query('UPDATE source_goals SET agent_id=$2,runtime_profile_id=$3 WHERE id=$1',[id,g.agent_id,g.runtime_profile_id]);}
   if(g.status==='deleted')throw sourceGoalError(409,'source_goal_stopped');
   const sessions=new PgSessionRepository(db);let sessionId=(g as typeof g & {session_id?:string}).session_id;
   if(!sessionId){const s=await sessions.createSession(g.space_id,g.owner_user_id,{projectId:g.project_id,title:g.intent_json.intent.slice(0,120),metadata:{source_goal_id:id}});sessionId=s.id;await db.query('UPDATE source_goals SET session_id=$2 WHERE id=$1',[id,sessionId]);}
   const old=await db.query(`SELECT id,run_id,content,metadata_json FROM messages WHERE session_id=$1 AND metadata_json->>'source_goal_message_key'=$2 AND role='user'`,[sessionId,input.idempotency_key]);if(old.rows[0]){if(old.rows[0].content!==input.content.trim()||(input.search_path!==undefined&&(old.rows[0].metadata_json?.source_goal_search_path??'agent')!==input.search_path)||(input.session_config!==undefined&&!isDeepStrictEqual(old.rows[0].metadata_json?.source_goal_session_config??[],input.session_config)))throw new HttpError(409,'Message request key changed');return {sessionId,id:old.rows[0].id,run_id:old.rows[0].run_id};}
   if((input.search_path??g.compatibility_json?.search_path)==='agent')await requireNativeCollector(db,g.runtime_profile_id);
   const active=await db.query(`SELECT 1 FROM runs WHERE space_id=$1 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$2 AND COALESCE(contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose','')<>'collect' AND status IN ('queued','running','waiting_for_review','waiting_for_dependency','cancelling') UNION ALL SELECT 1 FROM messages WHERE session_id=$3 AND metadata_json->>'source_goal_dispatch_pending'='true'`,[g.space_id,id,sessionId]);if(active.rows[0])throw sourceGoalError(409,'source_goal_run_in_progress');
   if(input.search_path!==undefined)await db.query(`UPDATE source_goals SET compatibility_json=COALESCE(compatibility_json,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[id,{search_path:input.search_path}]);
   if(input.session_config!==undefined){const backends=new PgConversationBackendRepository(db);const backend=await backends.resolveBinding({space_id:g.space_id,user_id:identity.userId,session_id:sessionId,agent_id:g.agent_id,requested:{runtime_profile_id:g.runtime_profile_id}});const selections=validateSessionConfig(input.session_config,backend.session_config_options??[]);await backends.saveSessionConfig(g.space_id,sessionId,g.agent_id,selections);}
   // Only an authenticated user's new message opens a bounded adjustment cycle.
   const cycle=(g.adjustment_cycle??0)+1;await db.query('UPDATE source_goals SET adjustment_cycle=$2,agent_attempts=0 WHERE id=$1',[id,cycle]);
   const baseIntent=typeof g.compatibility_json?.conversation_base_intent==='string'?g.compatibility_json.conversation_base_intent:g.intent_json.intent;
   if(!g.compatibility_json?.conversation_base_intent)await db.query(`UPDATE source_goals SET compatibility_json=COALESCE(compatibility_json,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[id,{conversation_base_intent:baseIntent}]);
   const prior=await db.query(`SELECT 1 FROM messages WHERE session_id=$1 AND role='user' LIMIT 1`,[sessionId]);
   if(prior.rows.length || g.intent_json.intent!==input.content.trim()){
    // Pre-UI plan versions have no intent snapshot. Freeze their existing
    // semantics on the goal, never mutate an immutable published version.
    if(g.active_version_id){const active=(await db.query<{plan_json:{intent_snapshot?:unknown}}>('SELECT plan_json FROM source_goal_versions WHERE id=$1 AND goal_id=$2',[g.active_version_id,g.id])).rows[0];const saved=g.compatibility_json?.active_intent_snapshot as {version_id?:string}|undefined;if(active&&!active.plan_json.intent_snapshot&&saved?.version_id!==g.active_version_id)await db.query(`UPDATE source_goals SET compatibility_json=COALESCE(compatibility_json,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[id,{active_intent_snapshot:{version_id:g.active_version_id,intent_json:g.intent_json}}]);}
    const intent=(baseIntent+'\n\n'+input.content.trim());if(intent.length>8000)throw new HttpError(422,'Goal refinement too long');await db.query(`UPDATE source_goals SET intent_json=$2,revision=revision+1,current_version_id=NULL WHERE id=$1`,[id,{...g.intent_json,intent}]);await db.query(`UPDATE source_goal_previews SET status='stale' WHERE goal_id=$1`,[id]);}
   const stored=await sessions.addMessage(g.space_id,g.owner_user_id,sessionId,{role:'user',content:input.content.trim(),metadata:{...(input.search_path?{source_goal_search_path:input.search_path}:{}),...(input.session_config!==undefined?{source_goal_session_config:input.session_config}:{}),source_goal_message_key:input.idempotency_key,source_goal_dispatch_pending:true,source_goal_cycle:cycle,source_goal_paused_request:g.status==='paused'}});if(!stored)throw new HttpError(404,'Conversation unavailable');return {sessionId,id:stored.id,run_id:null};
  });
  if(message.run_id)return {session_id:message.sessionId,run_id:message.run_id};
  try{const queued=await queueSourceGoalAgent(this.db,this.config,identity,id,'explore',undefined,{sessionId:message.sessionId,messageId:message.id});return {session_id:message.sessionId,...queued};}
  catch(error){
   // Queue admission and attachment are atomic. Preserve any committed binding
   // after an uncertain response; otherwise release this failed dispatch claim.
   const attached=(await this.db.query('SELECT run_id FROM messages WHERE id=$1 AND session_id=$2',[message.id,message.sessionId])).rows[0];
   if(attached?.run_id)return {session_id:message.sessionId,run_id:attached.run_id};
   const code=goalDispatchErrorCode(error);
   await this.db.query(`UPDATE messages SET metadata_json=(metadata_json-'source_goal_dispatch_pending')||$3::jsonb WHERE id=$1 AND session_id=$2 AND run_id IS NULL`,[message.id,message.sessionId,{source_goal_dispatch_failed:true,source_goal_dispatch_error:code}]);throw error;
  }
 }
}
