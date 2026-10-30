import type {GoalBindingRow} from './worker.js';
import {randomUUID} from 'node:crypto';import {type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';import {requireGoal} from './access.js';import {sourceGoalError} from './dispatchError.js';
/** Stage validated Agent-provided preview output for the existing native materialization/recovery
 * path. No new model invocation, scheduler or item writer. */
export async function stageManualSearch(tx:Queryable,identity:SpaceUserIdentity,goalId:string,versionId:string,previewId:string){

  await tx.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[goalId]);const g=await requireGoal(tx,identity,goalId,true);if(g.active_version_id!==versionId||g.compatibility_json?.execution_mode!=='manual')throw sourceGoalError(409,'source_native_stale_result');
  const p=(await tx.query<{result_json:{contributions:{source_connection_id:string;status:string;run_id?:string;output:unknown}[]}}>("SELECT result_json FROM source_goal_previews WHERE id=$1 AND goal_id=$2 AND version_id=$3 AND status='ready'",[previewId,goalId,versionId])).rows[0];if(!p)throw sourceGoalError(409,'source_native_stale_result');
  const bindings=await tx.query<GoalBindingRow & {source_connection_id:string}>('SELECT * FROM source_goal_bindings WHERE goal_id=$1 AND status=\'active\' FOR UPDATE',[goalId]);for(const b of bindings.rows){if(b.spec_json.implementation.kind!=='agent_search')throw sourceGoalError(409,'source_manual_implementation_unsupported');const prior=await tx.query("SELECT id FROM source_goal_runs WHERE binding_id=$1 AND result_json->>'manual_preview_id'=$2",[b.id,previewId]);if(prior.rows.length)continue;
   const contribution=p.result_json.contributions.find((c:{source_connection_id:string})=>c.source_connection_id===b.source_connection_id);if(!contribution||contribution.status!=='succeeded')throw sourceGoalError(409,'source_native_stale_result');const token=randomUUID();await tx.query("UPDATE source_goal_bindings SET status='collecting',lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",[b.id,token]);await tx.query("INSERT INTO source_goal_runs(id,space_id,goal_id,version_id,binding_id,status,result_json) VALUES($1,$2,$3,$4,$5,'accepted',$6)",[randomUUID(),g.space_id,g.id,versionId,b.id,{manual_preview_id:previewId,native_run_id:contribution.run_id,spec:b.spec_json,accepted_output:contribution.output,topic_signals:(contribution as {topic_signals?:unknown}).topic_signals??null,binding_revision:b.revision,materialization_token:token,cursor_before:b.cursor_json}]);
  }
  await tx.query("UPDATE source_goals SET compatibility_json=compatibility_json||jsonb_build_object('manual_pending',true,'manual_preview_id',$2::text) WHERE id=$1",[goalId,previewId]);
}
/** Continuous following reuses a fresh exact-version preview as its first
 * Agent-search batch through the same accepted-output/materialization path.
 * The audit marks the reuse so settlement defers that binding's next check to
 * the following interval: one confirmation never pays twice for one window. */
export async function stagePreviewBootstrap(tx:Queryable,g:{id:string;space_id:string},versionId:string,previewId:string,connectionIds:readonly string[]){
 const p=(await tx.query<{result_json:{contributions:{source_connection_id:string;status:string;run_id?:string;output:unknown}[]}}>("SELECT result_json FROM source_goal_previews WHERE id=$1 AND goal_id=$2 AND version_id=$3",[previewId,g.id,versionId])).rows[0];if(!p)throw sourceGoalError(409,'source_native_stale_result');
 const bindings=await tx.query<GoalBindingRow & {source_connection_id:string}>("SELECT * FROM source_goal_bindings WHERE goal_id=$1 AND status='active' AND source_connection_id=ANY($2::varchar[]) FOR UPDATE",[g.id,connectionIds]);
 for(const b of bindings.rows){
  if(b.spec_json.implementation.kind!=='agent_search')continue;
  if((await tx.query("SELECT 1 FROM source_goal_runs WHERE binding_id=$1 AND result_json->>'bootstrap_preview_id'=$2",[b.id,previewId])).rows.length)continue;
  const contribution=p.result_json.contributions.find(c=>c.source_connection_id===b.source_connection_id);if(!contribution||contribution.status!=='succeeded')continue;
  const token=randomUUID();await tx.query("UPDATE source_goal_bindings SET status='collecting',lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",[b.id,token]);
  await tx.query("INSERT INTO source_goal_runs(id,space_id,goal_id,version_id,binding_id,status,result_json) VALUES($1,$2,$3,$4,$5,'accepted',$6)",[randomUUID(),g.space_id,g.id,versionId,b.id,{bootstrap_preview_id:previewId,native_run_id:contribution.run_id,spec:b.spec_json,accepted_output:contribution.output,topic_signals:(contribution as {topic_signals?:unknown}).topic_signals??null,binding_revision:b.revision,materialization_token:token,cursor_before:b.cursor_json}]);
 }
}
