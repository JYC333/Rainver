import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {PgRunRepository} from '../runs/repository.js';
import {bodyWithheld} from '../access/contentAccessTypes.js';
import {loadAuthorizedCurrentContextMessage} from '../runtimeContext/productionAcquisition.js';
import {visibleMessagePathSql,nonSupersededMessageSql} from '../sessions/messagePath.js';

/** Resolve provenance, never infer semantic approval from matching text.
 * Reviewed closure may continue the same person's earlier visible instruction;
 * other callers (publication) require the current canonical message. Neither
 * accepts assembled context, assigned_task, attachments or assistant quotes. */
export async function workspaceClosureRequest(db:Queryable,actor:OperationActor,quote:string,allowEarlierMessages=false){
 if(!actor.run_id||!actor.on_behalf_of_user_id)return null;
 const run=await new PgRunRepository(db).getVisibleRun(actor.space_id,actor.on_behalf_of_user_id,actor.run_id);
 if(!run||bodyWithheld(run.effective_access_level)||run.trigger_origin!=='manual'
  ||run.instructed_by_user_id!==actor.on_behalf_of_user_id||run.delegation_id)return null;
 const override=run.model_override_json as {chat_turn?:unknown}|null;
 if(override?.chat_turn!==undefined){
  const turn=override.chat_turn as Record<string,unknown>|null;
  if(!turn||turn.schema_version!=='chat_turn.v1'||turn.kind==='handoff'
   ||!run.session_id||turn.session_id!==run.session_id||turn.user_id!==actor.on_behalf_of_user_id
   ||turn.agent_id!==run.agent_id||turn.project_id!==run.project_id
   ||typeof turn.user_message_id!=='string')return null;
  const message=await loadAuthorizedCurrentContextMessage(db,{messageId:turn.user_message_id,spaceId:actor.space_id,
   sessionId:run.session_id,userId:actor.on_behalf_of_user_id,runId:run.id});
  if(!message||message.role!=='user')return null;
  if(message.content.includes(quote))return {kind:'message' as const,id:turn.user_message_id};
  if(!allowEarlierMessages)return null;
  // Continue the same person's instruction on this visible branch. Never
  // search assembled prompts, other branches, future messages or attachments.
  const prior=(await db.query<{id:string;run_id:string}>(`SELECT candidate.id,candidate.run_id FROM messages candidate
   JOIN messages current ON current.id=$4 AND current.space_id=candidate.space_id AND current.session_id=candidate.session_id
   WHERE candidate.space_id=$1 AND candidate.session_id=$2 AND candidate.user_id=$3 AND candidate.role='user'
    AND candidate.run_id IS NOT NULL AND candidate.path_depth<current.path_depth
    AND position($5 in candidate.content)>0 AND ${nonSupersededMessageSql('candidate')}
    AND ${visibleMessagePathSql({alias:'candidate',spaceParam:'$1',sessionParam:'$2'})}
    AND ${visibleMessagePathSql({alias:'current',spaceParam:'$1',sessionParam:'$2'})}
   ORDER BY candidate.path_depth DESC,candidate.id DESC LIMIT 1`,[actor.space_id,run.session_id,actor.on_behalf_of_user_id,turn.user_message_id,quote])).rows[0];
  if(!prior)return null;
  const original=await loadAuthorizedCurrentContextMessage(db,{messageId:prior.id,spaceId:actor.space_id,sessionId:run.session_id,
   userId:actor.on_behalf_of_user_id,runId:prior.run_id});
  return original?.role==='user'&&original.content.includes(quote)?{kind:'message' as const,id:prior.id}:null;
 }
 // Legacy non-chat requests retain their direct instruction path. Never fall
 // back to assembled prompt text after a structured turn fails validation.
 if([run.instruction,run.prompt].some(text=>text?.includes(quote)))return {kind:'run_request' as const,id:run.id};
 return null;
}
