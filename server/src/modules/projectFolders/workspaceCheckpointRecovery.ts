import {randomUUID} from 'node:crypto';
import type {Queryable} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import {unlaunchedCheckpointSql,checkpointRecoveryPayload,type CheckpointRecovery} from './workspaceCheckpointState.js';
import {workspaceCheckpointFailureIsSafetyViolation,workspaceCheckpointRunSettledSql,WORKSPACE_TEMPORARY_HOST_ERRORS} from './workspacePolicy.js';
import type {HostConnectionRegistry} from '../hosts/connectionRegistry.js';
import {stopHostAttempt} from '../runs/executionControl.js';

/** A retry with no nonce does not erase an earlier dispatched attempt. Freeze
 * the terminal Run's whole dispatch history, then confirm each exact process. */
export async function confirmCheckpointExit(db:Queryable,spaceId:string,runId:string,hostId:string,hosts:HostConnectionRegistry){
 const attempts=(await db.query<{launch_id:string|null}>(`SELECT a.launch_id FROM runs r LEFT JOIN run_attempts a ON a.run_id=r.id AND a.space_id=r.space_id
  WHERE r.id=$1 AND r.space_id=$2 AND ${workspaceCheckpointRunSettledSql('r')}
   AND NOT EXISTS(SELECT 1 FROM run_execution_locks l WHERE l.run_id=r.id) ORDER BY a.attempt_number`,[runId,spaceId])).rows;
 if(!attempts.length)return {confirmed:false,dispatched:false};
 const nonces=[...new Set(attempts.flatMap(a=>a.launch_id?[a.launch_id]:[]))];
 for(const nonce of nonces)if(!(await stopHostAttempt(hosts,hostId,runId,nonce,false)).confirmed_exit)return {confirmed:false,dispatched:true};
 return {confirmed:true,dispatched:nonces.length>0};
}

/** Preconditions wait independently of the bounded retries of a Git operation. */
const WAIT_REASONS=new Set<string>([...WORKSPACE_TEMPORARY_HOST_ERRORS,
 'execution_workspace_host_upgrade_required','workspace_launch_identity_missing']);
export function checkpointFailurePolicy(error:unknown){
 const message=error instanceof Error?error.message:String(error);
 const reason=/^(workspace_|execution_workspace_|host_|task_|location_)[a-z_]+$/.test(message)?message:'workspace_checkpoint_operation_failed';
 return {reason,kind:workspaceCheckpointFailureIsSafetyViolation(error)?'blocked' as const
  :error instanceof JobDeferredError||WAIT_REASONS.has(reason)?'waiting' as const:'retry' as const};
}

/** Called under the workspace row lock by admission and periodic reconciliation.
 * Jobs transport the same checkpoint obligation; their retry exhaustion never
 * establishes content loss, process exit or permission to start another writer. */
export async function reconcileCheckpointObligations(db:Queryable,w:{id:string;space_id:string},userId:string,explicitRetry=false,retryChangeSetId?:string){
 const rows=(await db.query<{run_id:string;launch_sequence:number;checkpoint_state:string;recovery:CheckpointRecovery;change_set_id:string}>(`SELECT b.change_set_id,b.run_id,b.launch_sequence,b.checkpoint_state,b.checkpoint_recovery_json AS recovery
  FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
  WHERE b.workspace_id=$1 AND b.space_id=$2 AND b.checkpoint_state<>'saved' AND ${workspaceCheckpointRunSettledSql('r')}
  AND ($3::varchar IS NULL OR b.change_set_id=$3)
  AND (NOT EXISTS(SELECT 1 FROM execution_workspaces w WHERE w.id=b.workspace_id AND w.state='retired') OR ${unlaunchedCheckpointSql('b','r')})
  ORDER BY b.created_at,b.run_id FOR UPDATE OF b`,[w.id,w.space_id,explicitRetry?retryChangeSetId??null:null])).rows;
 let scheduled=0;
 for(const b of rows){
  if(b.checkpoint_state==='blocked')continue;
  let recovery=b.recovery;
  if(recovery.state==='exhausted'){
   if(!(explicitRetry&&(!retryChangeSetId||b.change_set_id===retryChangeSetId))&&checkpointFailurePolicy(recovery.error).kind!=='waiting')continue;
   recovery={state:'requested',request_id:randomUUID(),launch_sequence:b.launch_sequence};
   await db.query('UPDATE execution_workspace_runs SET checkpoint_recovery_json=$3::jsonb WHERE run_id=$1 AND workspace_id=$2',[b.run_id,w.id,JSON.stringify(recovery)]);
  }
  const payload=checkpointRecoveryPayload(b.run_id,w.id,b.launch_sequence,recovery);
  if(!(await db.query(`SELECT 1 FROM jobs WHERE job_type='execution_workspace_checkpoint' AND status IN ('pending','claimed','running') AND payload_json @> $1::jsonb LIMIT 1`,[JSON.stringify(payload)])).rowCount){
   await new PgJobQueueRepository(db).enqueue({job_type:'execution_workspace_checkpoint',space_id:w.space_id,user_id:userId,payload});scheduled++;
  }
 }
 return {blocked:rows.some(b=>b.checkpoint_state==='blocked'),pending:rows.some(b=>b.checkpoint_state==='pending'),scheduled};
}
