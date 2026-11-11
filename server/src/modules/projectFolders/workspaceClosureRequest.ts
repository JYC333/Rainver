import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {PgRunRepository} from '../runs/repository.js';
import {bodyWithheld} from '../access/contentAccessTypes.js';
import {loadAuthorizedCurrentContextMessage} from '../runtimeContext/productionAcquisition.js';

/** Resolve provenance, never infer semantic approval from matching text.
 * Chat turns use their canonical current user message, not assembled context,
 * assigned_task, old history, attachments or another Run's quoted instruction. */
export async function workspaceClosureRequest(db:Queryable,actor:OperationActor,quote:string){
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
  if(!message||message.role!=='user'||!message.content.includes(quote))return null;
  return {kind:'message' as const,id:turn.user_message_id};
 }
 // Legacy non-chat requests retain their direct instruction path. Never fall
 // back to assembled prompt text after a structured turn fails validation.
 if([run.instruction,run.prompt].some(text=>text?.includes(quote)))return {kind:'run_request' as const,id:run.id};
 return null;
}
