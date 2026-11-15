import {randomUUID} from 'node:crypto';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {refreshCleanupSummary,type WorkspaceCleanupResource} from './workspaceCleanup.js';

/** A moved source fence is a refusal, not evidence of candidate disposal. */
export async function renewCandidateCleanup(db:Queryable,w:ExecutionWorkspaceRow,key:string,r:WorkspaceCleanupResource,next:WorkspaceCleanupResource,userId:string){
  return withQueryableTransaction(db,async tx=>{
   const current=(await tx.query<ExecutionWorkspaceRow & {materialization_epoch:number;cleanup_json:Record<string,WorkspaceCleanupResource>}>('SELECT * FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   if(!current||current.generation!==r.workspace.generation||current.cleanup_json[key]?.operation_id!==r.operation_id)return {skipped:true};
   if(current.materialization_epoch<=(r.workspace.materialization_epoch??0))throw new JobDeferredError('workspace_candidate_epoch_unproven',30000);
   // Source release does not dispose a candidate. Only settled attempts with
   // no repair/verification Run may get a fresh, current-epoch deletion.
   const live=(await tx.query(`SELECT 1 FROM task_merges m WHERE m.workspace_id=$1
    AND ((m.attempt_id=$2 AND m.status IN ('queued','rebasing','resolving','verifying','waiting_local_changes'))
     OR EXISTS(SELECT 1 FROM runs run WHERE ((m.attempt_id=$2 AND (run.id=m.resolution_run_id OR run.id=m.detail_json->>'reply_owner_run_id'))
      OR (run.contract_snapshot_json->>'workspace_integration_id'=m.id AND run.contract_snapshot_json->>'workspace_integration_attempt_id'=$2))
      AND run.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review'))) LIMIT 1`,[w.id,r.workspace.integration_id])).rowCount;
   const owners=(await tx.query<{id:string}>(`WITH RECURSIVE history AS (
    SELECT id,attempt_id::text AS attempt_id,detail_json,0 AS depth FROM task_merges WHERE workspace_id=$1 AND ($3::text IS NULL OR id=$3)
    UNION ALL
    SELECT id,detail_json->>'previous_attempt',detail_json->'previous_detail',depth+1 FROM history
     WHERE depth<64 AND jsonb_typeof(detail_json->'previous_detail')='object'
   ) SELECT DISTINCT id FROM history WHERE attempt_id=$2 OR (depth<64 AND detail_json->>'previous_attempt'=$2)`,[w.id,r.workspace.integration_id,r.attempt_merge_id??null])).rows;
   if(live)throw new JobDeferredError('workspace_candidate_settlement_unproven',30000);
   if(owners.length!==1){
    await tx.query('UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1',[w.id,key,JSON.stringify({...next,state:'blocked',attempts:Math.max(next.attempts,8),error:'workspace_candidate_owner_unproven',next_retry_at:null})]);
    await refreshCleanupSummary(tx,w.id);return {blocked:true};
   }
   const renewed={...next,attempt_merge_id:owners[0]!.id,workspace:{...r.workspace,materialization_epoch:current.materialization_epoch},operation_id:randomUUID(),cleanup_sent:false,state:'pending',attempts:0,error:null,next_retry_at:null};
   delete renewed.cleanup_request;
   await tx.query('UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1',[w.id,key,JSON.stringify(renewed)]);
   await refreshCleanupSummary(tx,w.id);
   await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:userId,payload:{workspace_id:w.id,resource_key:key,operation_id:renewed.operation_id}});
   return {renewed:true};
  });
}
