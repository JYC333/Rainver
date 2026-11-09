import {deferIfSourceReleasePending} from './workspaceSourceFence.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {runActor,assertOperationGrant} from '../systemActions/operations/actor.js';
import {redactEvidenceText} from '../runs/evidenceRedaction.js';
import {randomUUID} from 'node:crypto';
import type {WorkspaceAgentVerificationSchema} from '@rainver/protocol';
import type {z} from 'zod';
import type {Pool} from '../../db/pool.js';
import type {ServerConfig} from '../../config.js';
import {withQueryableTransaction} from '../routeUtils/common.js';
import {tryWithDedicatedSessionAdvisoryLock} from '../../db/advisoryLock.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {PgRunRepository} from '../runs/repository.js';
import {bodyWithheld} from '../access/contentAccessTypes.js';
import {recordWorkspaceLaunch,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {hostLocationGit,pinRegisteredSource} from '../projectFolders/workspaceCommitSubmission.js';
import {workspacePublicationNeedsReview} from '../projectFolders/workspacePublication.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from './connectionRegistry.js';
import {workspaceLocationFrame} from './workspaceLocation.js';
import {workspaceHostFailureIsTemporary} from '../projectFolders/workspacePolicy.js';
import {agentGitIdentity} from '../runs/agentGitIdentity.js';
import {postWorkspaceIntegrationNotice} from '../projectFolders/workspaceIntegrationNotices.js';
import {PgVerificationRepository} from '../runs/verification/repository.js';

interface Request {id:string;action:'prepare'|'checkpoint'|'publish'|'reconcile';run_id:string;user_id:string;verification:z.infer<typeof WorkspaceAgentVerificationSchema>|null;action_id?:string;submitted_commit?:string|null}
/** A Git operation requested by the still-running native Agent. No repair Run,
 * fresh profile, command executor or final-summary model call is created. */
export async function processNativeWorkspaceRequest(pool:Pool,config:ServerConfig,changeId:string,spaceId:string,requestId:string,hosts:HostConnectionRegistry=sharedHostConnectionRegistry){
 const lock=await tryWithDedicatedSessionAdvisoryLock(pool,`workspace-native:${changeId}`,async()=>{
  const c=(await pool.query<{workspace_id:string;state:string;base_commit:string|null;source_commit:string|null;summary:string;originating_run_id:string;verification_json:{native_request?:Request;native_progress?:{status:string}}}>('SELECT * FROM workspace_change_sets WHERE id=$1 AND space_id=$2',[changeId,spaceId])).rows[0];
  const request=c?.verification_json.native_request;
  if(!c||!request||request.id!==requestId||c.verification_json.native_progress?.status!=='pending')return;
  const w=(await pool.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2',[c.workspace_id,spaceId])).rows[0];
  const runs=new PgRunRepository(pool),run=await runs.getVisibleRun(spaceId,request.user_id,request.run_id);
  let merge=(await pool.query<{id:string;source_commit:string;base_commit:string;attempt_id:string;detail_json:Record<string,unknown>}>('SELECT * FROM task_merges WHERE change_set_id=$1 AND space_id=$2',[changeId,spaceId])).rows[0];
  async function save(status:string,commit:string|null,onto:string|null,files:string[],error:string|null){
   const progress={request_id:requestId,action:request!.action,status,commit,onto_commit:onto,conflicted_files:files,error};
   await withQueryableTransaction(pool,async tx=>{
    const state=!merge&&request?.action==='checkpoint'?'open':status==='merged'?'integrated':status==='no_changes'?'no_changes':status==='failed'?'blocked':'integrating';
    const saved=await tx.query(`UPDATE workspace_change_sets SET state=$3,revision=revision+1,verification_json=verification_json||jsonb_build_object('native_progress',$4::jsonb),updated_at=now() WHERE id=$1 AND space_id=$2 AND verification_json->'native_request'->>'id'=$5`,[changeId,spaceId,state,JSON.stringify(progress),requestId]);
    if(!saved.rowCount)return;
    if(commit&&['prepared','conflict','checkpointed'].includes(status))await tx.query('UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1',[changeId,commit]);
    if(merge){
     const mStatus=status==='merged'?'merged':status==='no_changes'?'no_changes':status==='failed'?'failed':status==='conflict'?'resolving':'verifying';
     const verification=request!.verification?{status:'passed',level:request!.verification.checks.length?'project':'basic',execution:'agent_native',candidate_commit:commit,checked_commit:request!.verification.commit,note:redactEvidenceText(request!.verification.note),checks:request!.verification.checks.map(check=>({verifier_type:'agent',key:redactEvidenceText(check.command),status:'passed',summary:redactEvidenceText(check.summary)}))}:null;
     await tx.query(`UPDATE task_merges SET status=$2::varchar,revision=revision+1,onto_commit=COALESCE($3,onto_commit),task_commit=COALESCE($4,task_commit),merged_commit=CASE WHEN $2::varchar='merged' THEN $4::varchar ELSE merged_commit END,detail_json=detail_json||$5::jsonb,completed_at=CASE WHEN $2::varchar IN ('merged','no_changes','failed') THEN now() ELSE completed_at END,updated_at=now() WHERE id=$1`,[merge.id,mStatus,onto,commit,JSON.stringify({native_integration:true,native_progress:progress,error,conflicted_files:files,...(verification?{verification}:{})})]);
     if(status==='merged'&&commit){
      // A blocked batch of this workspace whose recorded delta this publication
      // carried is adopted: close it without another Git operation.
      const superseded=(await tx.query<{id:string;attempt_id:string;change_set_id:string}>(`UPDATE task_merges s SET status='no_changes',revision=s.revision+1,detail_json=s.detail_json||jsonb_build_object('already_present_at',$2::text,'adopted_by_integration_id',$1::text),completed_at=now(),updated_at=now()
       FROM task_merges p,workspace_change_sets c WHERE p.id=$1 AND s.workspace_id=p.workspace_id AND s.id<>p.id AND s.change_set_id=c.id AND c.state='blocked' AND s.status IN ('failed','conflict','verification_failed') AND s.base_commit=p.base_commit AND s.source_commit=p.source_commit AND s.target_ref=p.target_ref
       RETURNING s.id,s.attempt_id,s.change_set_id`,[merge.id,commit])).rows;
      for(const s of superseded){
       await tx.query(`UPDATE workspace_change_sets SET state='no_changes',revision=revision+1,verification_json=verification_json||$2::jsonb,updated_at=now() WHERE id=$1`,[s.change_set_id,JSON.stringify({native_progress:{request_id:requestId,action:'reconcile',status:'no_changes',commit,onto_commit:onto,conflicted_files:[],error:null},adopted_by_change_id:changeId})]);
       await postWorkspaceIntegrationNotice(tx,s.id,s.attempt_id,'no_changes');
      }
     }
     if(status==='merged'&&w?.parent_workspace_id&&commit){
      const updated=await tx.query('UPDATE execution_workspaces SET head_commit=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND (head_commit=$3 OR head_commit=$2) RETURNING id',[w.parent_workspace_id,commit,onto]);
      if(updated.rowCount)await tx.query("UPDATE workspace_change_sets SET source_commit=$2,verification_json=CASE WHEN jsonb_typeof(verification_json->'adopted_child_change_ids')='array' THEN jsonb_set(verification_json,'{adopted_child_change_ids}',(verification_json->'adopted_child_change_ids')||to_jsonb($3::text)) ELSE verification_json END WHERE workspace_id=$1 AND state IN ('open','ready')",[w.parent_workspace_id,commit,changeId]);
     }
     if(w?.parent_workspace_id&&['merged','no_changes','failed'].includes(status)){
      const parents=(await tx.query<{run_id:string}>("SELECT DISTINCT b.run_id FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=$1 AND r.status='waiting_for_dependency'",[w.parent_workspace_id])).rows;
      for(const parent of parents)await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_parent_reconcile',space_id:spaceId,user_id:request!.user_id,payload:{run_id:parent.run_id}});
     }
     if(['merged','no_changes','failed'].includes(status))await postWorkspaceIntegrationNotice(tx,merge.id,merge.attempt_id,status==='merged'?'integrated':status as 'no_changes'|'failed');
     if(status==='merged'&&verification){
      const at=new Date().toISOString();
      await new PgVerificationRepository(tx).upsertResults(spaceId,request!.run_id,[{verifier_type:'workspace_native',verifier_version:'agent_attested.v1',status:'passed',summary:'Agent checks in the original runtime environment; published tree matches checked version',evidence_refs_json:{integration_id:merge.id,candidate_commit:commit,checked_commit:request!.verification!.commit},details_json:{verification},started_at:at,completed_at:at}]);
     }
    }
   });
  }
  try{
   if(!w||!run||bodyWithheld(run.effective_access_level))throw new Error('integration_current_run_ended');
   if(['blocked','retired'].includes(w.state))throw new Error('execution_workspace_unavailable');
   await assertProjectWriterForMutation(pool,spaceId,w.project_id,request.user_id);
   const binding=(await pool.query<{change_set_id:string}>("SELECT change_set_id FROM execution_workspace_runs WHERE run_id=$1 AND workspace_id=$2 AND space_id=$3 AND access_mode='write'",[run.id,w.id,spaceId])).rows[0];
   if(!binding)throw new Error('integration_current_workspace_changed');
   const host=(await pool.query<{kind:string;owner_user_id:string|null}>('SELECT kind,owner_user_id FROM hosts WHERE id=$1',[w.execution_host_id])).rows[0];
   if(!host||host.kind==='remote'&&host.owner_user_id!==request.user_id)throw new Error('integration_host_authority_changed');
   const capability=(await pool.query<{native:boolean|null}>("SELECT (capabilities_json->>'native_workspace_integration')::boolean AS native FROM hosts WHERE id=$1",[w.execution_host_id])).rows[0]?.native;
   if(!capability)throw new Error('execution_host_native_integration_update_required');
   if(await workspacePublicationNeedsReview(pool,{spaceId,changeSetId:changeId,requesterId:request.user_id,repairRunId:null,instructionRunId:run.id}))throw new Error('workspace_egress_review_required');
   const origin=await runs.getVisibleRun(spaceId,request.user_id,c.originating_run_id);
   if(!origin||bodyWithheld(origin.effective_access_level))throw new Error('integration_origin_no_longer_visible');
   const sourceFrame=await workspaceLocationFrame(pool,w,{id:w.id,generation:w.generation},config.workspaceRoot,request.user_id);
   if(run.status!=='running'){
    if(request.action==='publish'&&merge&&w.target_ref){
     const evidence=await hosts.requestTaskBranch(w.execution_host_id,'workspace_integration',{workspace:{...sourceFrame,execution_workspace:{id:w.id,generation:w.generation,integration_id:merge.id}},action:'native_inspect',run_id:run.id,operation_id:requestId,source_commit:merge.source_commit,base_commit:merge.base_commit,target_ref:w.target_ref,author:agentGitIdentity(run.agent_id,null),message:c.summary});
     if(evidence.ok&&(evidence.outcome==='merged'||evidence.outcome==='no_changes')){await save(evidence.outcome==='merged'?'merged':'no_changes',evidence.candidate_commit,evidence.onto_commit,[],null);return;}
     if(!evidence.ok&&workspaceHostFailureIsTemporary(evidence.error))throw new JobDeferredError(evidence.error!,1000);
    }
    throw new Error('integration_current_run_ended');
   }
   await assertOperationGrant(pool,await runActor(pool,run),request.action_id??'workspace.change.complete');
   const inspected=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:sourceFrame,action:'inspect',operation_id:randomUUID(),run_id:run.id,retain_branch:true});
   if(!inspected.ok||!inspected.launch_info)throw new Error(inspected.error??'workspace_launch_identity_missing');
   await recordWorkspaceLaunch(pool,run,inspected.launch_info);
   const current=(await pool.query<{base_commit:string;source_commit:string|null}>('SELECT base_commit,source_commit FROM workspace_change_sets WHERE id=$1',[changeId])).rows[0]!;
   const base=merge?.base_commit??current.base_commit,source=merge?.source_commit??current.source_commit??inspected.commit??inspected.launch_info.start_commit;
   if(!base||!w.target_ref&&request.action!=='checkpoint')throw new Error('workspace_publish_basis_unavailable');
   // The worktree holds the batch bound to this Run. Any other batch of the
   // workspace is historical: it is prepared from its recorded commits, and
   // only while the bound batch has no unsubmitted changes of its own.
   let explicit:{submitted_commit:string;submitted_base?:string}|null=request.submitted_commit?{submitted_commit:request.submitted_commit}:null,worktreeBase=base;
   if(binding.change_set_id!==changeId&&request.action==='prepare'){
    const bound=(await pool.query<{base_commit:string|null}>('SELECT base_commit FROM workspace_change_sets WHERE id=$1',[binding.change_set_id])).rows[0];
    if(!merge?.source_commit||!merge.base_commit||!bound?.base_commit)throw new Error('workspace_publish_basis_unavailable');
    explicit={submitted_commit:merge.source_commit,submitted_base:merge.base_commit};worktreeBase=bound.base_commit;
   }
   if(!merge&&request.action!=='checkpoint'){
    const id=randomUUID(),attempt=randomUUID();
    // Durable dependency first, Host step after; the source-release fence
    // trigger admits it only while no unconfirmed deletion of its commits exists.
    await withQueryableTransaction(pool,async tx=>{
     await tx.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,detail_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$4,$6,$7,$8,$9,$10,'verifying',$11,$12::jsonb,now(),now()) ON CONFLICT(change_set_id) DO NOTHING`,[id,spaceId,w.id,changeId,w.workspace_location_id,w.generation,attempt,source,base,w.target_ref,request.user_id,JSON.stringify({native_integration:true,reply_owner_run_id:run.id})]);
    });
    merge=(await pool.query('SELECT * FROM task_merges WHERE change_set_id=$1',[changeId])).rows[0];
   }
   const m=merge!;
   const frame={workspace:{...sourceFrame,execution_workspace:{id:w.id,generation:w.generation,integration_id:m?.id??changeId}},action:`native_${request.action}` as 'native_prepare'|'native_checkpoint'|'native_publish'|'native_reconcile',run_id:run.id,operation_id:requestId,source_commit:source,base_commit:worktreeBase,target_ref:w.target_ref??`refs/heads/rainver/workspace-${w.id}-g${w.generation}`,author:agentGitIdentity(run.agent_id,null),message:c.summary,...(request.verification?{verified_commit:request.verification.commit}:{}),...explicit};
   if(w.parent_workspace_id){
    const parent=(await pool.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2',[w.parent_workspace_id,spaceId])).rows[0];
    if(!parent||parent.project_id!==w.project_id||parent.execution_host_id!==w.execution_host_id||parent.workspace_location_id!==w.workspace_location_id)throw new Error('native_parent_target_mismatch');
    Object.assign(frame,{target_workspace:{id:parent.id,generation:parent.generation}});
   }
   // An explicit commit (an Agent-submitted one, or a historical batch's
   // recorded source) is used by the Host below. Its dependent (the native
   // request, or the integration) passed the source-release fence, so it is
   // pinned now and proven present before it is used; a pruned one is refused.
   if(explicit)await pinRegisteredSource(await hostLocationGit(pool,w,run.id,hosts,config.workspaceRoot,request.user_id),explicit.submitted_commit);
   const effect=async()=>{
    const live=await runs.getRun(spaceId,run.id);
    if(live?.status!=='running')throw new Error('integration_current_run_ended');
    await assertProjectWriterForMutation(pool,spaceId,w.project_id,request.user_id);
    await assertOperationGrant(pool,await runActor(pool,live),request.action_id??'workspace.change.complete');
    if(await workspacePublicationNeedsReview(pool,{spaceId,changeSetId:changeId,requesterId:request.user_id,repairRunId:null,instructionRunId:run.id}))throw new Error('workspace_egress_review_required');
    return hosts.requestTaskBranch(w.execution_host_id,'workspace_integration',frame);
   };
   let reply;
   if(request.action==='publish'&&!w.parent_workspace_id){
    const folder=(await pool.query<{project_folder_id:string}>('SELECT project_folder_id FROM workspace_locations WHERE id=$1 AND space_id=$2',[w.workspace_location_id,spaceId])).rows[0];
    if(!folder)throw new Error('integration_source_folder_unavailable');
    const gate=await tryWithDedicatedSessionAdvisoryLock(pool,`code-patch-folder:${folder.project_folder_id}`,effect);
    if(!gate.acquired)throw new JobDeferredError('integration_source_folder_busy',1000);
    reply=gate.value;
   }else reply=await effect();
   if(!reply.ok&&workspaceHostFailureIsTemporary(reply.error))throw new JobDeferredError(reply.error!,1000);
   if(m&&reply.source_commit&&reply.base_commit)await pool.query('UPDATE task_merges SET source_commit=$2,base_commit=$3 WHERE id=$1',[m.id,reply.source_commit,reply.base_commit]);
   const status=!reply.ok?'failed':reply.outcome==='merged'?'merged':reply.outcome==='no_changes'?'no_changes':reply.outcome==='main_moved'?'target_moved':reply.outcome==='conflict'||reply.outcome==='unresolved'?'conflict':reply.outcome==='sealed'?'checkpointed':reply.outcome==='waiting_local_changes'?'failed':'prepared';
   await save(status,reply.candidate_commit,reply.onto_commit,reply.conflicted_files,reply.error??(reply.outcome==='waiting_local_changes'?'integration_waiting_local_changes':null));
  }catch(error){if(error instanceof JobDeferredError)throw error;deferIfSourceReleasePending(error);await save('failed',null,null,[],error instanceof Error?error.message:'native_integration_failed');}
 });
 if(!lock.acquired)throw new JobDeferredError('integration_already_advancing',1000);
}

/** A stopped Agent cannot leave a manager waiting on a prepared batch forever.
 * Pending Host receipts are reconciled by their durable Job before closure. */
export async function closeEndedNativeWorkspaceRequests(db:import('../routeUtils/common.js').Queryable,workspaceId:string){
 return withQueryableTransaction(db,async tx=>{
  const ended=(await tx.query<{id:string;space_id:string;parent_workspace_id:string|null;requested_by_user_id:string;merge_id:string;attempt_id:string}>(`UPDATE workspace_change_sets c SET state='blocked',revision=c.revision+1,verification_json=jsonb_set(c.verification_json,'{native_progress}',(c.verification_json->'native_progress')||'{"status":"failed","error":"integration_current_run_ended"}'::jsonb),updated_at=now()
   FROM runs r,execution_workspaces w,task_merges m WHERE c.workspace_id=$1 AND w.id=c.workspace_id AND r.id=c.completion_basis AND r.space_id=c.space_id AND m.change_set_id=c.id AND m.space_id=c.space_id
    AND c.state='integrating' AND c.verification_json->'native_progress'->>'status' IN ('prepared','conflict','checkpointed','target_moved') AND r.status IN ('succeeded','failed','degraded','cancelled','orphaned')
   RETURNING c.id,c.space_id,w.parent_workspace_id,m.requested_by_user_id,m.id AS merge_id,m.attempt_id`,[workspaceId])).rows;
  for(const c of ended){
   await tx.query("UPDATE task_merges SET status='failed',revision=revision+1,detail_json=detail_json||'{\"error\":\"integration_current_run_ended\"}'::jsonb,updated_at=now(),completed_at=now() WHERE id=$1",[c.merge_id]);
   await postWorkspaceIntegrationNotice(tx,c.merge_id,c.attempt_id,'failed');
   if(c.parent_workspace_id){
    const parents=(await tx.query<{run_id:string}>("SELECT DISTINCT b.run_id FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=$1 AND r.status='waiting_for_dependency'",[c.parent_workspace_id])).rows;
    for(const parent of parents)await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_parent_reconcile',space_id:c.space_id,user_id:c.requested_by_user_id,payload:{run_id:parent.run_id}});
   }
  }
  return ended.length;
 });
}
