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
 async begin(identity:SpaceUserIdentity,input:{intent:string;project_id?:string|null;idempotency_key?:string}){
  assertSafeGoalMessage(input.intent);
  const scope=await resolveContentCreationContext(this.db,{userId:identity.userId,requestSpaceId:identity.spaceId,projectId:input.project_id});
  const selected=await this.db.query(`SELECT a.id,p.id AS profile_id FROM agents a JOIN agent_runtime_profiles p ON p.agent_id=a.id AND p.space_id=a.space_id WHERE a.space_id=$1 AND a.owner_user_id=$2 AND a.status='active' AND a.agent_kind<>'system_assistant' AND p.enabled=true ORDER BY p.is_default DESC,a.created_at,p.id LIMIT 1`,[scope.spaceId,identity.userId]);
  const agent=selected.rows[0];if(!agent)throw sourceGoalError(409,'source_goal_execution_setup_required');
  return new SourceGoalService(this.db,this.config,new SourceGoalExecutor(this.db,this.config)).create({...identity,spaceId:scope.spaceId},{intent:input.intent,project_id:scope.projectId,creation_key:input.idempotency_key,agent_id:agent.id,runtime_profile_id:agent.profile_id,budget:SourceGoalBudgetSchema.parse({})});
 }
 async send(identity:SpaceUserIdentity,id:string,input:{content:string;idempotency_key:string}){
  if(!input.content?.trim() || input.content.length>8000 || !input.idempotency_key || input.idempotency_key.length>128)throw new HttpError(422,'Invalid goal message');
  assertSafeGoalMessage(input.content);
  const message=await withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true);
   if(!g.agent_id || !g.runtime_profile_id){const p=await db.query<{id:string;profile_id:string}>(`SELECT a.id,p.id AS profile_id FROM agents a JOIN agent_runtime_profiles p ON p.agent_id=a.id AND p.space_id=a.space_id WHERE a.space_id=$1 AND a.owner_user_id=$2 AND a.status='active' AND a.agent_kind<>'system_assistant' AND p.enabled=true ORDER BY p.is_default DESC,a.created_at LIMIT 1`,[g.space_id,g.owner_user_id]);if(!p.rows[0])throw sourceGoalError(409,'source_goal_execution_setup_required');g.agent_id=p.rows[0].id;g.runtime_profile_id=p.rows[0].profile_id;await db.query('UPDATE source_goals SET agent_id=$2,runtime_profile_id=$3 WHERE id=$1',[id,g.agent_id,g.runtime_profile_id]);}
   if(g.status==='deleted')throw sourceGoalError(409,'source_goal_stopped');
   const sessions=new PgSessionRepository(db);let sessionId=(g as typeof g & {session_id?:string}).session_id;
   if(!sessionId){const s=await sessions.createSession(g.space_id,g.owner_user_id,{projectId:g.project_id,title:g.intent_json.intent.slice(0,120),metadata:{source_goal_id:id}});sessionId=s.id;await db.query('UPDATE source_goals SET session_id=$2 WHERE id=$1',[id,sessionId]);}
   const old=await db.query(`SELECT id,run_id,content FROM messages WHERE session_id=$1 AND metadata_json->>'source_goal_message_key'=$2 AND role='user'`,[sessionId,input.idempotency_key]);if(old.rows[0]){if(old.rows[0].content!==input.content.trim())throw new HttpError(409,'Message request key changed');return {sessionId,id:old.rows[0].id,run_id:old.rows[0].run_id};}
   const active=await db.query(`SELECT 1 FROM runs WHERE space_id=$1 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$2 AND status IN ('queued','running','waiting_for_review','waiting_for_dependency','cancelling') UNION ALL SELECT 1 FROM messages WHERE session_id=$3 AND metadata_json->>'source_goal_dispatch_pending'='true'`,[g.space_id,id,sessionId]);if(active.rows[0])throw sourceGoalError(409,'source_goal_run_in_progress');
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
   const stored=await sessions.addMessage(g.space_id,g.owner_user_id,sessionId,{role:'user',content:input.content.trim(),metadata:{source_goal_message_key:input.idempotency_key,source_goal_dispatch_pending:true,source_goal_cycle:cycle,source_goal_paused_request:g.status==='paused'}});if(!stored)throw new HttpError(404,'Conversation unavailable');return {sessionId,id:stored.id,run_id:null};
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
