import {configureWorkspaceRetention} from './workspaceRetention.js';
import {deferIfSourceReleasePending} from './workspaceSourceFence.js';
import {processNativeWorkspaceRequest,closeEndedNativeWorkspaceRequests} from './workspaceNativeIntegration.js';
import {freezeSubmittedWorkspaceCommit} from '../projectFolders/workspaceCommitSubmission.js';
import {workspaceHostFailureIsTemporary,workspaceCheckpointFailureIsSafetyViolation,workspaceCheckpointRunSettledSql} from '../projectFolders/workspacePolicy.js';
import {workspaceLocationFrame} from './workspaceLocation.js';
import {enqueueWorkspaceIntegration} from './workspaceIntegrations.js';
import {enqueueWorkspaceCleanup,registerWorkspaceCleanupJobs} from './workspaceCleanup.js';
import {PgRunRepository} from '../runs/repository.js';
import {AgentGroupRunLifecycleProjector} from '../agentGroups/lifecycleProjector.js';
import {randomUUID} from 'node:crypto';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {JobDeferredError,type JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from './connectionRegistry.js';
import {workspaceReference,completedWorkspaceRun,recordWorkspaceLaunch,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {agentGitIdentity} from '../runs/agentGitIdentity.js';
import {assertProjectWriterForMutation} from '../projects/access.js';

export async function checkpointWorkspaceRun(db:Queryable,runId:string,spaceId:string,hosts:HostConnectionRegistry=sharedHostConnectionRegistry,workspaceRoot?:string,attempt:{exhausted?:boolean;recoveryId?:string}={}){
 const rows=(await db.query<ExecutionWorkspaceRow & {start_commit:string|null;change_set_id:string;agent_id:string|null;user_id:string|null;checkpoint_state:string;checkpoint_commit:string|null;launch_sequence:number;access_mode:string;recovery_state:string|null;recovery_id:string|null}>(`SELECT c.verification_json->'checkpoint_recovery'->>'state' AS recovery_state,c.verification_json->'checkpoint_recovery'->>'request_id' AS recovery_id,w.*,b.start_commit,b.change_set_id,b.checkpoint_state,b.checkpoint_commit,b.launch_sequence,b.access_mode,r.agent_id,COALESCE(r.instructed_by_user_id,r.owner_user_id) AS user_id FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id JOIN runs r ON r.id=b.run_id JOIN workspace_change_sets c ON c.id=b.change_set_id WHERE b.run_id=$1 AND b.space_id=$2`,[runId,spaceId])).rows;
 const failures:unknown[]=[];
 for(const w of rows){
  try{
  if(['saved','blocked'].includes(w.checkpoint_state)||!w.start_commit||w.recovery_state==='exhausted'||attempt.recoveryId!==undefined&&(w.recovery_id??'')!==attempt.recoveryId)continue;
  if(!w.user_id)throw new Error('workspace_checkpoint_actor_missing');
  await assertProjectWriterForMutation(db,spaceId,w.project_id,w.user_id);
  const reply=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:await workspaceLocationFrame(db,w,workspaceReference(w),workspaceRoot,w.user_id),action:'checkpoint',operation_id:randomUUID(),run_id:runId,author:agentGitIdentity(w.agent_id,null),message:`Workspace change ${w.change_set_id}`,retain_branch:true});
  if(!reply.ok||!reply.commit){
   const reason=reply.error??'workspace_checkpoint_commit_missing';
   if(workspaceHostFailureIsTemporary(reason))throw new JobDeferredError(reason,30000);
   throw new Error(reason);
  }
  if(w.access_mode==='read'&&reply.commit!==w.start_commit){
   await blockCheckpoint(db,runId,w.id,'read_only_workspace_modified',reply.commit);continue;
  }
  await withQueryableTransaction(db,async tx=>{
   const owner=(await tx.query<{state:string;generation:number}>('SELECT state,generation FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   if(!owner||['blocked','retired'].includes(owner.state)||owner.generation!==w.generation)return;
   const saved=await tx.query(`UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$3 WHERE run_id=$1 AND workspace_id=$2 AND checkpoint_state='pending' AND launch_sequence=$4 AND start_commit=$5`,[runId,w.id,reply.commit??w.start_commit,w.launch_sequence,w.start_commit]);
   if(!saved.rowCount)return;
   await tx.query("UPDATE workspace_change_sets SET verification_json=verification_json-'checkpoint_recovery' WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs WHERE change_set_id=$1 AND checkpoint_state<>'saved')",[w.change_set_id]);
   await tx.query(`UPDATE execution_workspaces SET head_commit=$2,head_sequence=$4,updated_at=now() WHERE id=$1 AND generation=$3 AND head_sequence<$4`,[w.id,reply.commit,w.generation,w.launch_sequence]);
   await tx.query(`UPDATE workspace_change_sets SET source_commit=$2,source_sequence=$3,updated_at=now() WHERE id=$1 AND source_sequence<$3`,[w.change_set_id,reply.commit,w.launch_sequence]);
   const closed=await tx.query(`UPDATE workspace_change_sets c SET state='no_changes',revision=revision+1,updated_at=now()
    WHERE c.id=$1 AND c.state='open' AND c.base_commit=c.source_commit AND NOT(c.verification_json ? 'submitted_commit')
     AND EXISTS(SELECT 1 FROM runs completed WHERE completed.id=$2 AND completed.space_id=c.space_id AND completed.status='succeeded')
     AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.change_set_id=c.id AND (b.checkpoint_state<>'saved' OR r.status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency')))
     AND NOT EXISTS(SELECT 1 FROM runs child JOIN execution_workspace_runs b ON b.run_id=child.parent_run_id WHERE b.change_set_id=c.id)
     AND NOT EXISTS(SELECT 1 FROM execution_workspaces child WHERE child.parent_workspace_id=c.workspace_id) RETURNING id`,[w.change_set_id,runId]);
   const nativeFinished=(await tx.query("SELECT 1 FROM workspace_change_sets WHERE id=$1 AND state IN ('integrated','no_changes') AND verification_json ? 'native_progress'",[w.change_set_id])).rowCount;
   if(closed.rowCount||nativeFinished)await enqueueWorkspaceCleanup(tx,w,{id:w.id,generation:w.generation},reply.commit!,true,w.user_id!);

  });
  }catch(error){
   deferIfSourceReleasePending(error);
   if(!(error instanceof JobDeferredError))await recordCheckpointFailure(db,runId,w.id,error,attempt.exhausted??false,w.recovery_id??'');
   failures.push(error);
  }
 }
 for(const w of rows)await closeEndedNativeWorkspaceRequests(db,w.id);
 throwCheckpointFailure(failures);
}
/** A settled CLI phase may complete publication while its owning Run is still
 * running. No other active Run or unsaved binding is exempted. */
export async function completeExecutionWorkspace(db:Queryable,config:ServerConfig,hosts:HostConnectionRegistry,job:{space_id:string;user_id:string|null;payload:Record<string,unknown>},beforeReplyRunId?:string){
  const id=String(job.payload.change_set_id??'');
  const c=(await db.query<{state:string;base_commit:string|null;source_commit:string|null;originating_run_id:string;workspace_id:string;verification_json:Record<string,unknown>}>('SELECT * FROM workspace_change_sets WHERE id=$1 AND space_id=$2',[id,job.space_id])).rows[0];
  if(!c||c.state!=='ready')return {skipped:true};
  if((await db.query("SELECT 1 FROM execution_workspace_runs WHERE change_set_id=$1 AND checkpoint_state='blocked' LIMIT 1",[id])).rowCount){
   await db.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$2::jsonb WHERE id=$1 AND state='ready'",[id,JSON.stringify({error:'workspace_checkpoint_blocked'})]);
   return {state:'blocked'};
  }
  const origin=await completedWorkspaceRun(db,id,job.space_id);
  if(!origin||origin.id!==beforeReplyRunId&&['queued','running','cancelling','waiting_for_review','waiting_for_dependency'].includes(origin.status))throw new JobDeferredError('Workspace Run has not succeeded',10000);
  if(origin.status!=='succeeded'&&!(origin.id===beforeReplyRunId&&origin.status==='running')){
   await db.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$2::jsonb WHERE id=$1 AND state='ready'",[id,JSON.stringify({error:'completion_run_not_succeeded'})]);
   return {state:'blocked'};
  }
  const owner=(await db.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1',[c.workspace_id])).rows[0]!;
  if(['blocked','retired'].includes(owner.state)){
   await db.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$2::jsonb WHERE id=$1 AND state='ready'",[id,JSON.stringify({error:'workspace_checkpoint_blocked'})]);
   return {state:'blocked'};
  }
  if(!owner.parent_workspace_id){
   const children=(await db.query<{active:boolean;owed:boolean;blocked:boolean}>(`SELECT
    EXISTS(SELECT 1 FROM runs r WHERE r.root_run_id=$1 AND r.id<>$2 AND r.space_id=$3 AND r.status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency')) AS active,
    EXISTS(SELECT 1 FROM workspace_change_sets child JOIN execution_workspace_runs b ON b.change_set_id=child.id JOIN runs r ON r.id=b.run_id WHERE r.root_run_id=$1 AND r.id<>$2 AND r.space_id=$3 AND child.id<>$4 AND child.state IN ('ready','integrating')) AS owed,
    EXISTS(SELECT 1 FROM workspace_change_sets child JOIN execution_workspace_runs b ON b.change_set_id=child.id JOIN runs r ON r.id=b.run_id WHERE r.root_run_id=$1 AND r.id<>$2 AND r.space_id=$3 AND child.id<>$4 AND child.state='blocked') AS blocked`,[origin.root_run_id??origin.id,origin.id,job.space_id,id])).rows[0]!;
   if(children.active)throw new JobDeferredError('Delegated workspace results still running',10000);
   if(children.owed)throw new JobDeferredError('Delegated workspace integration still owed',10000);
   if(!children.owed&&!children.active&&job.user_id){
    const descendants=(await db.query('SELECT 1 FROM execution_workspaces WHERE parent_workspace_id=$1 LIMIT 1',[owner.id])).rowCount;
    if(descendants){await refreshWorkspaceHead(db,owner,job.user_id,hosts,config.workspaceRoot);c.source_commit=(await db.query<{source_commit:string}>('SELECT source_commit FROM workspace_change_sets WHERE id=$1',[id])).rows[0]!.source_commit;}
   }
   if(children.blocked){await db.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$2::jsonb WHERE id=$1 AND state='ready'",[id,JSON.stringify({error:'delegated_integration_blocked'})]);return {state:'blocked'};}
  }
  const pending=(await db.query("SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.change_set_id=$1 AND (b.checkpoint_state<>'saved' OR (r.id IS DISTINCT FROM $2 AND r.status IN ('running','queued','cancelling','waiting_for_dependency','waiting_for_review')))",[id,beforeReplyRunId??null])).rowCount;
  if(pending)throw new JobDeferredError('Workspace checkpoint still owed',10000);
  if(c.verification_json.submitted_commit){
   if(!job.user_id)throw new Error('workspace_completion_actor_missing');
   try{
    const submitted=await freezeSubmittedWorkspaceCommit(db,owner,{...c,id},origin,job.user_id,hosts,config.workspaceRoot,beforeReplyRunId);
    if(submitted){c.base_commit=submitted.base_commit;c.source_commit=submitted.source_commit;}
   }catch(error){
    if(error instanceof JobDeferredError)throw error;
    deferIfSourceReleasePending(error);
    const reason=error instanceof Error&&error.message.startsWith('workspace_commit_')?error.message:'workspace_commit_unavailable';
    await db.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$2::jsonb WHERE id=$1 AND state='ready'",[id,JSON.stringify({error:reason})]);
    return {state:'blocked',error:reason};
   }
  }
  if(c.base_commit&&c.base_commit===c.source_commit){
   await withQueryableTransaction(db,async tx=>{
    const gate=(await tx.query<{state:string}>('SELECT state FROM execution_workspaces WHERE id=$1 FOR UPDATE',[c.workspace_id])).rows[0];
    if(!gate||['blocked','retired'].includes(gate.state)||(await tx.query("SELECT 1 FROM execution_workspace_runs WHERE change_set_id=$1 AND checkpoint_state<>'saved'",[id])).rowCount)throw new Error('workspace_checkpoint_blocked');
    await tx.query("UPDATE workspace_change_sets SET state='no_changes',revision=revision+1 WHERE id=$1 AND state='ready'",[id]);
    const w=(await tx.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1',[c.workspace_id])).rows[0]!;
    await enqueueWorkspaceCleanup(tx,w,{id:w.id,generation:w.generation},c.source_commit!,true,job.user_id!);
    if(w.parent_workspace_id)await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_parent_reconcile',space_id:job.space_id,user_id:job.user_id,payload:{run_id:origin.parent_run_id}});
   });return {state:'no_changes'};
  }
  if(!c.base_commit||!c.source_commit||!owner.target_ref){
   await db.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$2::jsonb WHERE id=$1 AND state='ready'",[id,JSON.stringify({error:'workspace_publish_basis_unavailable'})]);
   return {state:'blocked'};
  }
  if(!job.user_id)throw new Error('workspace_completion_actor_missing');
  const integrationId=await enqueueWorkspaceIntegration(db,id,job.space_id,job.user_id,beforeReplyRunId??(typeof c.verification_json.reply_owner_run_id==='string'?c.verification_json.reply_owner_run_id:undefined));
  if(integrationId)return {state:'integrating',integration_id:integrationId};
  const blocked=await db.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$2::jsonb WHERE id=$1 AND state='ready' RETURNING state",[id,JSON.stringify({error:'workspace_integration_not_enqueued'})]);
  if(blocked.rowCount)return {state:'blocked'};
  const current=(await db.query<{state:string}>('SELECT state FROM workspace_change_sets WHERE id=$1 AND space_id=$2',[id,job.space_id])).rows[0];
  return {state:current?.state??'missing',skipped:true};
}

export function registerExecutionWorkspaceJobs(registry:JobHandlerRegistry,config:ServerConfig,hosts=sharedHostConnectionRegistry){
 if(!config.databaseUrl)return;
 const db=getDbPool(config.databaseUrl);
 configureWorkspaceRetention(config);
 registerWorkspaceCleanupJobs(registry,db,hosts,config.workspaceRoot);
 registry.register('execution_workspace_parent_reconcile',async job=>{
  const run=await new PgRunRepository(db).getRun(job.space_id,String(job.payload.run_id));
  if(run){
   const workspaces=(await db.query<ExecutionWorkspaceRow>('SELECT w.* FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id WHERE b.run_id=$1 AND b.space_id=$2',[run.id,run.space_id])).rows;
   for(const w of workspaces)if(job.user_id)await refreshWorkspaceHead(db,w,job.user_id,hosts,config.workspaceRoot);
   await new AgentGroupRunLifecycleProjector(db,config).reconcileWaitingRun(run);
  }
  return {reconciled:true};
 });
 registry.register('execution_workspace_checkpoint',async job=>{
  const runId=String(job.payload.run_id??'');
  const run=(await db.query<{status:string;settled:boolean}>(`SELECT r.status,${workspaceCheckpointRunSettledSql('r')} AS settled FROM runs r WHERE r.id=$1 AND r.space_id=$2`,[runId,job.space_id])).rows[0];
  if(!run||['running','queued','cancelling'].includes(run.status)||run.status==='waiting_for_dependency'&&!run.settled)throw new JobDeferredError('Workspace process has not settled',10000);
  const attempt={exhausted:job.attempts>=job.max_attempts,recoveryId:typeof job.payload.checkpoint_recovery_id==='string'?job.payload.checkpoint_recovery_id:''};
  const missing=(await db.query<ExecutionWorkspaceRow & {recovery_id:string|null;recovery_state:string|null}>(`SELECT c.verification_json->'checkpoint_recovery'->>'request_id' AS recovery_id,c.verification_json->'checkpoint_recovery'->>'state' AS recovery_state,w.* FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id JOIN workspace_change_sets c ON c.id=b.change_set_id WHERE b.run_id=$1 AND b.space_id=$2 AND b.start_commit IS NULL AND b.checkpoint_state<>'blocked'`,[runId,job.space_id])).rows;
  const failures:unknown[]=[];
  for(const w of missing){
   if(w.recovery_state==='exhausted'||(w.recovery_id??'')!==attempt.recoveryId)continue;
   try{
   if(!job.user_id)throw new Error('workspace_checkpoint_actor_missing');
   await assertProjectWriterForMutation(db,job.space_id,w.project_id,job.user_id);
   const inspected=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:await workspaceLocationFrame(db,w,workspaceReference(w),config.workspaceRoot,job.user_id),action:'inspect',run_id:runId,operation_id:randomUUID(),retain_branch:true});
   if(!inspected.ok){
    const reason=inspected.error??'workspace_host_unavailable';
    if(workspaceHostFailureIsTemporary(reason))throw new JobDeferredError(reason,30000);
    throw new Error(reason);
   }
   const origin=await new PgRunRepository(db).getRun(job.space_id,runId);
   if(inspected.launch_info&&origin)await recordWorkspaceLaunch(db,origin,inspected.launch_info);
   else throw new Error('workspace_launch_identity_missing');
   }catch(error){
    deferIfSourceReleasePending(error);
    if(!(error instanceof JobDeferredError))await recordCheckpointFailure(db,runId,w.id,error,attempt.exhausted,w.recovery_id??'');
    failures.push(error);
   }
  }
  try{await checkpointWorkspaceRun(db,runId,job.space_id,hosts,config.workspaceRoot,attempt);}catch(error){failures.push(error);}
  throwCheckpointFailure(failures);
  const parent=await new PgRunRepository(db).getRun(job.space_id,runId);
  if(parent)await new AgentGroupRunLifecycleProjector(db,config).queueDelegatedChildren(parent);
  return {checkpointed:true};
 });
 registry.register('execution_workspace_complete',job=>completeExecutionWorkspace(db,config,hosts,job));
 registry.register('execution_workspace_native_integrate',async job=>{await processNativeWorkspaceRequest(db,config,String(job.payload.change_set_id),job.space_id,String(job.payload.request_id),hosts);return {processed:true};});
}

/** Refresh a yielded parent's branch before its next prompt/publication. */
export async function refreshWorkspaceHead(db:Queryable,w:ExecutionWorkspaceRow,userId:string,hosts:HostConnectionRegistry,workspaceRoot?:string){
 await assertProjectWriterForMutation(db,w.space_id,w.project_id,userId);
 const host=(await db.query<{kind:string;owner_user_id:string|null}>('SELECT kind,owner_user_id FROM hosts WHERE id=$1',[w.execution_host_id])).rows[0];
 if(!host||host.kind==='remote'&&host.owner_user_id!==userId)throw new Error('workspace_head_host_authority_changed');
 const reply=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{
  workspace:await workspaceLocationFrame(db,w,workspaceReference(w),workspaceRoot,userId),action:'inspect',operation_id:randomUUID(),retain_branch:true});
 if(!reply.ok||!reply.commit)throw new JobDeferredError(reply.error??'workspace_head_unavailable',30000);
 await withQueryableTransaction(db,async tx=>{
  const updated=await tx.query('UPDATE execution_workspaces SET head_commit=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$3',[w.id,reply.commit,w.revision]);
  if(updated.rowCount)await tx.query("UPDATE workspace_change_sets SET source_commit=$2,updated_at=now() WHERE workspace_id=$1 AND state IN ('open','ready')",[w.id,reply.commit]);
 });
}

/** Keep progressing independent repositories, then preserve the Job retry class. */
function throwCheckpointFailure(failures:unknown[]){
 if(failures.length)throw failures.find(error=>!(error instanceof JobDeferredError))??failures[0];
}


/** Only positive safety evidence taints an owner; late success cannot clear it. */
async function blockCheckpoint(db:Queryable,runId:string,workspaceId:string,reason:string,commit?:string){
 await withQueryableTransaction(db,async tx=>{
  await tx.query('SELECT id FROM execution_workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
  await tx.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked',checkpoint_commit=COALESCE($3,checkpoint_commit) WHERE run_id=$1 AND workspace_id=$2",[runId,workspaceId,commit??null]);
  await tx.query("UPDATE execution_workspaces SET state='blocked' WHERE id=$1 AND state<>'retired'",[workspaceId]);
  await tx.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$3::jsonb WHERE id=(SELECT change_set_id FROM execution_workspace_runs WHERE run_id=$1 AND workspace_id=$2) AND state IN ('open','ready','integrating','blocked')",[runId,workspaceId,JSON.stringify({error:reason})]);
 });
}

/** Operational retries keep pending bindings and their previous saved results.
 * The JSON request identity fences exhausted old Jobs from a new explicit retry. */
async function recordCheckpointFailure(db:Queryable,runId:string,workspaceId:string,error:unknown,exhausted:boolean,requestId:string){
 if(workspaceCheckpointFailureIsSafetyViolation(error)){
  await blockCheckpoint(db,runId,workspaceId,error instanceof Error&&'statusCode' in error?'workspace_checkpoint_permission_changed':String(error instanceof Error?error.message:error));return;
 }
 await withQueryableTransaction(db,async tx=>{
  await tx.query('SELECT id FROM execution_workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
  const reason=error instanceof Error&&/^(workspace_|execution_workspace_)[a-z_]+$/.test(error.message)?error.message:'workspace_checkpoint_operation_failed';
  await tx.query(`UPDATE workspace_change_sets c SET
   state=CASE WHEN $3 THEN 'blocked' ELSE c.state END,revision=revision+CASE WHEN $3 AND c.state<>'blocked' THEN 1 ELSE 0 END,
   verification_json=verification_json||jsonb_build_object('checkpoint_recovery',$4::jsonb),updated_at=now()
   WHERE c.id=(SELECT change_set_id FROM execution_workspace_runs WHERE run_id=$1 AND workspace_id=$2 AND checkpoint_state='pending')
    AND c.state IN ('open','ready','blocked')
    AND COALESCE(c.verification_json->'checkpoint_recovery'->>'request_id','')=$5
    AND NOT EXISTS(SELECT 1 FROM execution_workspaces WHERE id=$2 AND state IN ('blocked','retired'))`,
   [runId,workspaceId,exhausted,JSON.stringify({state:exhausted?'exhausted':'retrying',error:reason,run_id:runId,request_id:requestId,recovery_action:'workspace.change.complete'}),requestId]);
 });
}
