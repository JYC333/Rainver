import {configureWorkspaceRetention} from './workspaceRetention.js';
import {registerWorkspaceBranchAlignJob} from '../projectFolders/workspaceBranchAlign.js';
import {deferIfSourceReleasePending} from './workspaceSourceFence.js';
import {processNativeWorkspaceRequest} from './workspaceNativeIntegration.js';
import {freezeSubmittedWorkspaceCommit} from '../projectFolders/workspaceCommitSubmission.js';
import {workspaceCheckpointRunSettledSql} from '../projectFolders/workspacePolicy.js';
import {workspaceLocationFrame} from './workspaceLocation.js';
import {enqueueWorkspaceIntegration} from './workspaceIntegrations.js';
import {enqueueWorkspaceCleanup,registerWorkspaceCleanupJobs} from './workspaceCleanup.js';
import {PgRunRepository} from '../runs/repository.js';
import {checkpointWorkspaceRun} from './workspaceCheckpoints.js';
export {checkpointWorkspaceRun} from './workspaceCheckpoints.js';
import {AgentGroupRunLifecycleProjector} from '../agentGroups/lifecycleProjector.js';
import {randomUUID} from 'node:crypto';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {JobDeferredError,type JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from './connectionRegistry.js';
import {workspaceReference,completedWorkspaceRun,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {assertProjectWriterForMutation} from '../projects/access.js';

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
 registerWorkspaceBranchAlignJob(registry,db,config,hosts);
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
  const result=await checkpointWorkspaceRun(db,runId,job.space_id,hosts,config.workspaceRoot,{...attempt,workspaceId:typeof job.payload.workspace_id==='string'?job.payload.workspace_id:undefined,launchSequence:typeof job.payload.launch_sequence==='number'?job.payload.launch_sequence:undefined,confirmParkedExit:true});
  if(result.superseded)return {checkpointed:false,superseded:true};
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
  const updated=await tx.query(`UPDATE execution_workspaces SET retention_json=CASE WHEN head_commit IS DISTINCT FROM $2 THEN retention_json||jsonb_build_object('content_changed_at',now()) ELSE retention_json END,head_commit=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$3`,[w.id,reply.commit,w.revision]);
  if(updated.rowCount)await tx.query("UPDATE workspace_change_sets SET source_commit=$2,updated_at=now() WHERE workspace_id=$1 AND state IN ('open','ready')",[w.id,reply.commit]);
 });
}
