import {randomUUID} from 'node:crypto';
import {withQueryableTransaction,HttpError,type Queryable} from '../routeUtils/common.js';
import {PgConversationRuntimeSessionRepository} from '../sessions/conversationRuntimeSessionRepository.js';
import {PgConversationExecutionContextRepository,type ExecutionContextRow} from '../sessions/executionContextRepository.js';
import {runtimeAvailability} from '../sessions/executionRuntimeAvailability.js';
import {PgSessionRepository} from '../sessions/repository.js';
import {PgHostThreadRepository} from './threadRepository.js';

export function matchesConversationWorkspace(target:{execution_host_id:string|null;workspace_mode?:string|null;workspace_location_id:string|null},context:ExecutionContextRow){
 return target.execution_host_id===context.execution_host_id&&target.workspace_mode===context.primary_workspace_mode
  &&target.workspace_location_id===context.primary_workspace_location_id;
}

/** Adopt an explicit edit to the bound Profile for future turns only. Reads do
 * not migrate; admission uses the same conversation lock as dispatch. */
export async function rebindConversationRuntime(db:Queryable,input:{spaceId:string;userId:string;sessionId:string;agentId:string;requestedProfileId?:string|null}){
 return withQueryableTransaction(db,async tx=>{
  await new PgConversationRuntimeSessionRepository(tx).lockConversation(input.spaceId,input.sessionId);
  const repository=new PgConversationExecutionContextRepository(tx),identity={spaceId:input.spaceId,userId:input.userId};
  const existingContext=await repository.getContext(input.spaceId,input.sessionId);if(existingContext?.state!=='initialized')return;
  const binding=await repository.getBinding(input.spaceId,input.sessionId,input.agentId);if(!binding)return;
  if(input.requestedProfileId&&input.requestedProfileId!==binding.runtime_profile_id)return;
  await tx.query('SELECT id FROM agent_runtime_profiles WHERE id=$1 AND space_id=$2 AND agent_id=$3 FOR SHARE',[binding.runtime_profile_id,input.spaceId,input.agentId]);
  const profile=await repository.getRuntimeProfile(input.spaceId,input.agentId,binding.runtime_profile_id);
  const threads=new PgHostThreadRepository(tx),thread=await threads.getForConversationAgent(input.spaceId,input.sessionId,input.agentId);
  if(!profile||!thread)return;
  await tx.query('SELECT id FROM host_threads WHERE id=$1 FOR UPDATE',[thread.id]);
  if(profile.runtime_key===thread.runtime_key&&profile.runtime_installation===thread.runtime_installation)return;
  const session=await repository.getVisibleSession(identity,input.sessionId,{forUpdate:true});
  if(!session||!await repository.canAgentParticipate(session,input.agentId,input.userId))throw new HttpError(403,'Conversation Agent is unavailable');
  const context=await repository.lockDraft(session);
  if(!matchesConversationWorkspace(profile,context)||!matchesConversationWorkspace(thread,context))throw new HttpError(409,'Runtime changes must retain the Conversation Host and Primary Workspace');
  const host=(await repository.listHosts(input.userId)).find(h=>h.id===context.execution_host_id)??null;
  const location=context.primary_workspace_location_id?(await repository.listProjectLocations(input.spaceId,session.project_id)).find(l=>l.id===context.primary_workspace_location_id)??null:null;
  const availability=runtimeAvailability(profile,host,location,{allowStaleLocation:true});
  if(!availability.usable)throw new HttpError(409,availability.reason??'Selected runtime is unavailable');
  const active=await tx.query(`SELECT 1 FROM runs WHERE host_task_thread_id=$1 AND status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency') LIMIT 1`,[thread.id]);
  if(thread.dispatch_lock_id||context.dispatch_lock_id||active.rowCount)throw new HttpError(409,'The current Run must settle before switching its runtime');
  await tx.query("UPDATE host_threads SET status='closed',updated_at=now() WHERE id=$1",[thread.id]);
  await repository.bindRuntime({...input,profileId:profile.id});
  if(profile.runtime_key!==thread.runtime_key)await tx.query("UPDATE session_conversation_backends SET session_config_json='[]'::jsonb WHERE space_id=$1 AND session_id=$2 AND agent_id=$3",[input.spaceId,input.sessionId,input.agentId]);
  const next=await threads.getOrCreateForConversationAgent({executionHostId:thread.execution_host_id!,workspaceMode:thread.workspace_mode,workspaceLocationId:thread.workspace_location_id,
   spaceId:input.spaceId,sessionId:input.sessionId,agentId:input.agentId,runtimeKey:profile.runtime_key,runtimeInstallation:profile.runtime_installation!,createdByUserId:input.userId});
  // Physical workspace identity survives the runtime session replacement.
  await tx.query('UPDATE host_threads SET execution_workspace_json=(SELECT execution_workspace_json FROM host_threads WHERE id=$2) WHERE id=$1',[next.id,thread.id]);
  await new PgSessionRepository(tx).addExecutionSystemEvent(input.spaceId,input.userId,input.sessionId,{
   event:'execution_agent_runtime_changed',eventKey:`execution_runtime_changed:${randomUUID()}`,
   content:`Agent ${profile.agent_name} switched to ${profile.runtime_key} (${profile.runtime_installation}). A new CLI session will continue this Conversation; existing files and history are preserved.`,
   details:{agent_id:input.agentId,runtime_profile_id:profile.id,previous_thread_id:thread.id,host_thread_id:next.id,runtime_key:profile.runtime_key,runtime_installation:profile.runtime_installation},
  });
 });
}
