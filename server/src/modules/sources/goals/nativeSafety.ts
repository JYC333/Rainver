import {PgConversationBackendRepository} from '../../sessions/conversationBackendRepository.js';
import {HttpError} from '../../routeUtils/common.js';
import type {Queryable} from '../../routeUtils/common.js';
import {sourceGoalError} from './dispatchError.js';
/** Ordinary canonical Profile executability. This never attests search capability. */
export async function requireNativeCollector(db:Queryable,profileId:string){
 const r=(await db.query<{agent_id:string;space_id:string;owner_user_id:string}>(`SELECT p.agent_id,p.space_id,a.owner_user_id FROM agent_runtime_profiles p JOIN agents a ON a.id=p.agent_id AND a.space_id=p.space_id WHERE p.id=$1 AND p.enabled=true AND a.status='active'`,[profileId])).rows[0];
 if(!r)throw sourceGoalError(409,'source_goal_execution_setup_required');
 const option=(await new PgConversationBackendRepository(db).listOptions(r.space_id,r.owner_user_id,r.agent_id)).find(o=>o.runtime_profile_id===profileId);
 if(!option||option.usable===false)throw sourceGoalError(409,'source_goal_execution_setup_required');
}
export async function nativeSearchAvailability(db:Queryable,identity:{spaceId:string;userId:string},profileId:string){
 const p=(await db.query(`SELECT p.runtime_key FROM agent_runtime_profiles p JOIN agents a ON a.id=p.agent_id AND a.space_id=p.space_id WHERE p.id=$1 AND a.space_id=$2 AND a.owner_user_id=$3 AND a.status='active' AND p.enabled=true`,[profileId,identity.spaceId,identity.userId])).rows[0];
 if(!p)return {supported:false,reason:'source_goal_execution_setup_required'};
 try{await requireNativeCollector(db,profileId);return {supported:true,runtime_key:p.runtime_key,verification:'agent_provided_unverified' as const};}catch(error){if(!(error instanceof HttpError))throw error;return {supported:false,runtime_key:p.runtime_key,reason:'source_goal_execution_setup_required'};}
}
