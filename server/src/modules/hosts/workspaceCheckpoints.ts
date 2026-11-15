import {randomUUID} from 'node:crypto';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from './connectionRegistry.js';
import {workspaceLocationFrame} from './workspaceLocation.js';
import {appendContributorSql} from '../projectFolders/workspaceContributors.js';
import {workspaceReference,recordWorkspaceLaunch,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {recoverUnlaunchedWorkspaceCheckpoint} from '../projectFolders/workspaceUnlaunchedCheckpoint.js';
import {workspaceHostFailureIsTemporary} from '../projectFolders/workspacePolicy.js';
import {deferIfSourceReleasePending} from './workspaceSourceFence.js';
import {closeEndedNativeWorkspaceRequests} from './workspaceNativeIntegration.js';
import {enqueueWorkspaceCleanup} from './workspaceCleanup.js';
import {agentGitIdentity} from '../runs/agentGitIdentity.js';
import {PgRunRepository} from '../runs/repository.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import type {CheckpointRecovery} from '../projectFolders/workspaceCheckpointState.js';
import {checkpointFailurePolicy,confirmCheckpointExit} from '../projectFolders/workspaceCheckpointRecovery.js';

export async function checkpointWorkspaceRun(db:Queryable,runId:string,spaceId:string,hosts:HostConnectionRegistry=sharedHostConnectionRegistry,workspaceRoot?:string,
 attempt:{exhausted?:boolean;recoveryId?:string;workspaceId?:string;launchSequence?:number;confirmParkedExit?:boolean}={}){
 const rows=(await db.query<ExecutionWorkspaceRow & {start_commit:string|null;change_set_id:string;agent_id:string|null;user_id:string|null;checkpoint_state:string;checkpoint_commit:string|null;launch_sequence:number;access_mode:string;run_status:string;recovery:CheckpointRecovery}>(`SELECT w.*,b.start_commit,b.change_set_id,b.checkpoint_state,b.checkpoint_commit,b.launch_sequence,b.access_mode,
  b.checkpoint_recovery_json AS recovery,r.status AS run_status,r.agent_id,COALESCE(r.instructed_by_user_id,r.owner_user_id) AS user_id
  FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id JOIN runs r ON r.id=b.run_id
  WHERE b.run_id=$1 AND b.space_id=$2 AND ($3::varchar IS NULL OR b.workspace_id=$3)`,[runId,spaceId,attempt.workspaceId??null])).rows;
 const failures:unknown[]=[];let superseded=false,exitConfirmed=false;
 if(attempt.workspaceId&&rows.length===0)return {superseded:true};
 for(const w of rows){
  if(attempt.launchSequence!==undefined&&w.launch_sequence!==attempt.launchSequence
   ||attempt.recoveryId!==undefined&&(w.recovery.request_id??'')!==attempt.recoveryId){superseded=true;continue;}
  if(w.checkpoint_state==='saved')continue;
  try{
   if(w.checkpoint_state==='blocked')throw new Error('workspace_checkpoint_blocked');
   if(!w.start_commit&&await recoverUnlaunchedWorkspaceCheckpoint(db,runId,w.id,spaceId,hosts,workspaceRoot))continue;
   if(w.recovery.state==='exhausted')throw new Error('workspace_checkpoint_recovery_exhausted');
   if(attempt.confirmParkedExit&&!exitConfirmed){
    if(!(await confirmCheckpointExit(db,spaceId,runId,w.execution_host_id,hosts)).confirmed)
     throw new JobDeferredError('workspace_checkpoint_exit_unconfirmed',10000);
    exitConfirmed=true;
   }
   if(!w.user_id)throw new Error('workspace_checkpoint_actor_missing');
   await assertProjectWriterForMutation(db,spaceId,w.project_id,w.user_id);
   if(!w.start_commit){
    const inspected=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{
     workspace:await workspaceLocationFrame(db,w,workspaceReference(w),workspaceRoot,w.user_id),action:'inspect',run_id:runId,operation_id:randomUUID(),retain_branch:true});
    if(!inspected.ok){if(workspaceHostFailureIsTemporary(inspected.error))throw new JobDeferredError(inspected.error!,30000);throw new Error(inspected.error??'workspace_host_unavailable');}
    const origin=await new PgRunRepository(db).getRun(spaceId,runId);
    if(!inspected.launch_info||!origin)throw new Error('workspace_launch_identity_missing');
    await recordWorkspaceLaunch(db,origin,inspected.launch_info);
    const current=(await db.query<{start_commit:string;launch_sequence:number;recovery:CheckpointRecovery}>(`SELECT start_commit,launch_sequence,checkpoint_recovery_json AS recovery FROM execution_workspace_runs WHERE run_id=$1 AND workspace_id=$2`,[runId,w.id])).rows[0]!;
    if(attempt.launchSequence!==undefined&&current.launch_sequence!==attempt.launchSequence){superseded=true;continue;}
    Object.assign(w,current);
   }
   const reply=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{
    workspace:await workspaceLocationFrame(db,w,workspaceReference(w),workspaceRoot,w.user_id),action:'checkpoint',launch_sequence:w.launch_sequence||undefined,
    operation_id:randomUUID(),run_id:runId,author:agentGitIdentity(w.agent_id,null),message:`Workspace change ${w.change_set_id}`,retain_branch:true});
   if(!reply.ok||!reply.commit){
    const reason=reply.error??'workspace_checkpoint_commit_missing';
    if(reason==='workspace_checkpoint_launch_moved'){
     const inspected=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{
      workspace:await workspaceLocationFrame(db,w,workspaceReference(w),workspaceRoot,w.user_id),action:'inspect',run_id:runId,operation_id:randomUUID(),retain_branch:true});
     const run=await new PgRunRepository(db).getRun(spaceId,runId);
     if(run&&inspected.launch_info&&(inspected.launch_info.launch_sequence??0)>w.launch_sequence){
      await recordWorkspaceLaunch(db,run,inspected.launch_info);superseded=true;continue;
     }
    }
    if(workspaceHostFailureIsTemporary(reason))throw new JobDeferredError(reason,30000);
    throw new Error(reason);
   }
   if(w.access_mode==='read'&&reply.commit!==w.start_commit){
    if(!await blockCheckpoint(db,runId,w.id,'read_only_workspace_modified',w.launch_sequence,w.recovery.request_id??'',reply.commit)){superseded=true;continue;}
    throw new Error('workspace_checkpoint_blocked');
   }
  await withQueryableTransaction(db,async tx=>{
   const owner=(await tx.query<{state:string;generation:number}>('SELECT state,generation FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   if(owner?.state==='blocked')throw new Error('workspace_checkpoint_blocked');
   if(!owner||owner.state==='retired')throw new Error('workspace_checkpoint_owner_unavailable');
   if(owner.generation!==w.generation){superseded=true;return;}
   const saved=await tx.query(`UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$3,checkpoint_recovery_json='{}'::jsonb WHERE run_id=$1 AND workspace_id=$2 AND checkpoint_state='pending' AND launch_sequence=$4 AND start_commit=$5 AND COALESCE(checkpoint_recovery_json->>'request_id','')=$6`,[runId,w.id,reply.commit,w.launch_sequence,w.start_commit,w.recovery.request_id??'']);
   if(!saved.rowCount){superseded=true;return;}
   await tx.query(`UPDATE execution_workspaces SET retention_json=CASE WHEN head_commit IS DISTINCT FROM $2 THEN retention_json||jsonb_build_object('content_changed_at',now()) ELSE retention_json END,head_commit=$2,head_sequence=$4,updated_at=now() WHERE id=$1 AND generation=$3 AND head_sequence<$4`,[w.id,reply.commit,w.generation,w.launch_sequence]);
   // The checkpointing Run is this version's contributor (workspaceContributors).
   await tx.query(`UPDATE workspace_change_sets SET source_commit=$2,source_sequence=$3,verification_json=${appendContributorSql('$4')},updated_at=now() WHERE id=$1 AND source_sequence<$3`,[w.change_set_id,reply.commit,w.launch_sequence,runId]);
   const closed=await tx.query(`UPDATE workspace_change_sets c SET state='no_changes',revision=revision+1,updated_at=now()
    WHERE c.id=$1 AND c.state='open' AND c.base_commit=c.source_commit AND NOT(c.verification_json ? 'submitted_commit')
     AND EXISTS(SELECT 1 FROM runs completed WHERE completed.id=$2 AND completed.space_id=c.space_id AND completed.status='succeeded')
     AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.change_set_id=c.id AND (b.checkpoint_state<>'saved' OR r.status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency')))
     AND NOT EXISTS(SELECT 1 FROM runs child JOIN execution_workspace_runs b ON b.run_id=child.parent_run_id WHERE b.change_set_id=c.id)
     AND NOT EXISTS(SELECT 1 FROM execution_workspaces child WHERE child.parent_workspace_id=c.workspace_id) RETURNING id`,[w.change_set_id,runId]);
   const nativeFinished=(await tx.query("SELECT 1 FROM workspace_change_sets WHERE id=$1 AND state IN ('integrated','no_changes') AND verification_json ? 'native_progress'",[w.change_set_id])).rowCount;
   if(closed.rowCount||nativeFinished||w.owner_kind==='delegation')await enqueueWorkspaceCleanup(tx,w,{id:w.id,generation:w.generation},reply.commit!,true,w.user_id!);

  });

  }catch(error){
   deferIfSourceReleasePending(error);
   if(w.checkpoint_state!=='blocked'&&w.recovery.state!=='exhausted'){
    const current=await recordCheckpointFailure(db,runId,w.id,error,attempt.exhausted??false,w.launch_sequence,w.recovery.request_id??'');
    if(!current){superseded=true;continue;}
   }
   const failure=checkpointFailurePolicy(error);
   failures.push(failure.kind==='waiting'&&!(error instanceof JobDeferredError)?new JobDeferredError(failure.reason,30000):error);
  }
 }
 for(const w of rows)await closeEndedNativeWorkspaceRequests(db,w.id);
 throwCheckpointFailure(failures);
 if(superseded)return {superseded:true};
 // A skipped, retired or unresolved binding is never a successful checkpoint.
 if((await db.query(`SELECT 1 FROM execution_workspace_runs WHERE run_id=$1 AND space_id=$2
  AND ($3::varchar IS NULL OR workspace_id=$3) AND checkpoint_state<>'saved' LIMIT 1`,[runId,spaceId,attempt.workspaceId??null])).rowCount)
  throw new JobDeferredError('Workspace checkpoint is still owed',10000);
 return {superseded:false};
}

function throwCheckpointFailure(failures:unknown[]){
 if(failures.length)throw failures.find(error=>!(error instanceof JobDeferredError))??failures[0];
}

async function currentCheckpointBlocked(db:Queryable,runId:string,workspaceId:string,sequence:number,requestId:string){
 return Boolean((await db.query(`SELECT 1 FROM execution_workspace_runs WHERE run_id=$1 AND workspace_id=$2
  AND checkpoint_state='blocked' AND launch_sequence=$3 AND COALESCE(checkpoint_recovery_json->>'request_id','')=$4`,[runId,workspaceId,sequence,requestId])).rowCount);
}

/** Only positive safety evidence taints an owner; late success cannot clear it. */
async function blockCheckpoint(db:Queryable,runId:string,workspaceId:string,reason:string,sequence:number,requestId:string,commit?:string){
 return withQueryableTransaction(db,async tx=>{
  await tx.query('SELECT id FROM execution_workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
  const blocked=await tx.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked',checkpoint_commit=COALESCE($3,checkpoint_commit) WHERE run_id=$1 AND workspace_id=$2 AND checkpoint_state<>'blocked' AND launch_sequence=$4 AND (COALESCE(checkpoint_recovery_json->>'request_id','')=$5 OR checkpoint_state='saved')",[runId,workspaceId,commit??null,sequence,requestId]);
  if(!blocked.rowCount)return currentCheckpointBlocked(tx,runId,workspaceId,sequence,requestId);
  await tx.query("UPDATE execution_workspaces SET state='blocked' WHERE id=$1 AND state<>'retired'",[workspaceId]);
  await tx.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$3::jsonb WHERE id=(SELECT change_set_id FROM execution_workspace_runs WHERE run_id=$1 AND workspace_id=$2) AND state IN ('open','ready','integrating','blocked')",[runId,workspaceId,JSON.stringify({error:reason})]);
  return true;
 });
}

/** Operational retries keep pending bindings and their previous saved results.
 * The JSON request identity fences exhausted old Jobs from a new explicit retry. */
async function recordCheckpointFailure(db:Queryable,runId:string,workspaceId:string,error:unknown,exhausted:boolean,sequence:number,requestId:string){
 const failure=checkpointFailurePolicy(error);
 if(failure.kind==='blocked'){
  return blockCheckpoint(db,runId,workspaceId,error instanceof Error&&'statusCode' in error?'workspace_checkpoint_permission_changed':String(error instanceof Error?error.message:error),sequence,requestId);
 }
 const reason=failure.reason;
 const updated=await db.query(`UPDATE execution_workspace_runs SET checkpoint_recovery_json=$5::jsonb
  WHERE run_id=$1 AND workspace_id=$2 AND checkpoint_state='pending' AND launch_sequence=$3
   AND COALESCE(checkpoint_recovery_json->>'request_id','')=$4`,[runId,workspaceId,sequence,requestId,
  JSON.stringify({state:failure.kind==='waiting'?'waiting':exhausted?'exhausted':'retrying',error:reason,launch_sequence:sequence,request_id:requestId,recovery_action:'workspace.change.complete'})]);
 if(updated.rowCount)return true;
 return currentCheckpointBlocked(db,runId,workspaceId,sequence,requestId);
}
