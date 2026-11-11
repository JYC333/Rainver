import {assertWorkspaceContributorsReadable} from '../projectFolders/workspaceContributors.js';
import {deferIfSourceReleasePending} from './workspaceSourceFence.js';
import {verifyBasicWorkspaceCandidate} from './workspaceBasicVerification.js';
import {workspaceVerificationFolder} from '../projectFolders/workspaceVerificationFolder.js';
import {bodyWithheld} from '../access/contentAccessTypes.js';
import {runOutputResult} from '../runs/orchestrationResults.js';
import {LaunchWorkspaceSchema,HostLaunchWorkspaceAccessSchema,type HostLaunchWorkspaceAccess} from '@rainver/protocol';
import {executionWorkspaceMountRef} from './workspaceScopes.js';
import {tryWithDedicatedSessionAdvisoryLock} from '../../db/advisoryLock.js';
import {workspaceLocationFrame} from './workspaceLocation.js';
import {postWorkspaceIntegrationNotice} from '../projectFolders/workspaceIntegrationNotices.js';
import {randomUUID} from 'node:crypto';
import type {ExecutionWorkspaceRef} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Pool} from '../../db/pool.js';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import {PgRunRepository,type RunRecord} from '../runs/repository.js';
import {PgVerificationEngine,type WorkspaceVerificationOutcome} from '../runs/verification/engine.js';
import {HostCommandVerificationExecutor} from '../runs/verification/hostCommandExecutor.js';
import {agentGitIdentity} from '../runs/agentGitIdentity.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry,type HostRequestPayload} from './connectionRegistry.js';
import {enqueueWorkspaceCleanup} from './workspaceCleanup.js';
import {workspaceHostFailureIsTemporary,WORKSPACE_INTEGRATION_LIMITS as limits} from '../projectFolders/workspacePolicy.js';
import {completedWorkspaceRun,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {dispatchWorkspaceRepair,requestedWorkspaceRepairOrigin} from '../projectFolders/workspaceRepair.js';
import {workspacePublicationNeedsReview} from '../projectFolders/workspacePublication.js';

export interface WorkspaceIntegrationRow {
 id:string;space_id:string;workspace_id:string;change_set_id:string;workspace_location_id:string;
 generation:number;revision:number;attempt_id:string;status:string;source_commit:string;base_commit:string;target_ref:string;
 onto_commit:string|null;task_commit:string|null;resolution_run_id:string|null;requested_by_user_id:string;
 detail_json:Record<string,unknown>;
}
import {frozenPublicationDetail,frozenPublicationPlan,requiresNativePublication} from '../projectFolders/workspacePublicationPlan.js';
export const integrationWorkspaceReference=(m:WorkspaceIntegrationRow):ExecutionWorkspaceRef=>({id:m.workspace_id,generation:m.generation,integration_id:m.attempt_id});
export async function enqueueWorkspaceIntegration(db:Queryable,changeId:string,spaceId:string,userId:string,replyOwnerRunId?:string){
 return withQueryableTransaction(db,async tx=>{
  const owner=(await tx.query<{state:string}>(`SELECT w.state FROM workspace_change_sets c JOIN execution_workspaces w ON w.id=c.workspace_id WHERE c.id=$1 AND c.space_id=$2 FOR UPDATE OF w`,[changeId,spaceId])).rows[0];
  if(!owner||['blocked','retired'].includes(owner.state))return null;
  if((await tx.query("SELECT 1 FROM execution_workspace_runs WHERE change_set_id=$1 AND checkpoint_state<>'saved' LIMIT 1",[changeId])).rowCount)return null;
  const c=(await tx.query<{workspace_id:string;generation:number;state:string;base_commit:string;source_commit:string;target_ref:string;workspace_location_id:string;execution_host_id:string}>(`SELECT c.*,w.target_ref,w.workspace_location_id,w.execution_host_id FROM workspace_change_sets c JOIN execution_workspaces w ON w.id=c.workspace_id WHERE c.id=$1 AND c.space_id=$2 FOR UPDATE OF c`,[changeId,spaceId])).rows[0];
  if(!c||c.state!=='ready'||!c.source_commit||!c.base_commit||!c.target_ref)return null;
  // This insert is a dependent of its source/candidate commits: the
  // workspace_source_release_fence trigger admits it only while no unconfirmed
  // deletion of that shared source ref exists on this Host (workspaceSourceFence).
  const id=randomUUID();
  const inserted=await tx.query<{id:string}>(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$4,$6,$7,$8,$9,$10,'queued',$11,now(),now()) ON CONFLICT(change_set_id) DO NOTHING RETURNING id`,
   [id,spaceId,c.workspace_id,changeId,c.workspace_location_id,c.generation,randomUUID(),c.source_commit,c.base_commit,c.target_ref,userId]);
  if(!inserted.rowCount)return null;
  if(replyOwnerRunId)await tx.query("UPDATE task_merges SET detail_json=detail_json||$2::jsonb WHERE id=$1",[id,JSON.stringify({reply_owner_run_id:replyOwnerRunId})]);
  await tx.query("UPDATE workspace_change_sets SET state='integrating',revision=revision+1,updated_at=now() WHERE id=$1",[changeId]);
  await new PgJobQueueRepository(tx).enqueue({job_type:'task_merge',space_id:spaceId,user_id:userId,payload:{merge_id:id,workspace_id:c.workspace_id}});
  return id;
 });
}
export interface WorkspaceIntegrationDeps {
 hosts?:HostConnectionRegistry;
 verify?:(input:{run:RunRecord;target:Parameters<PgVerificationEngine['verifyTaskWorkspace']>[0]['target'];base_commit_sha:string})=>Promise<WorkspaceVerificationOutcome>;
 repair?:typeof dispatchWorkspaceRepair;
}
/** The existing task_merge Job dispatches generic owners here; one merge queue. */
export async function advanceWorkspaceIntegration(pool:Pool,config:ServerConfig,id:string,spaceId:string,deps:WorkspaceIntegrationDeps={}){
 const client=await pool.connect(),hosts=deps.hosts??sharedHostConnectionRegistry;
 const key=`workspace-integration:${id}`;
 let locked=false;
 try{
  locked=(await client.query<{ok:boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[key])).rows[0]?.ok===true;
  if(!locked)throw new JobDeferredError('integration_already_advancing',5000);
  const m=(await client.query<WorkspaceIntegrationRow>('SELECT * FROM task_merges WHERE id=$1 AND space_id=$2 AND workspace_id IS NOT NULL',[id,spaceId])).rows[0];
  if(!m||m.detail_json.native_integration===true)return {skipped:true};
  if(['merged','no_changes','superseded','failed','verification_failed','conflict'].includes(m.status)){
   if(m.status!=='superseded')await postWorkspaceIntegrationNotice(client,m.id,m.attempt_id,m.status==='merged'?'integrated':m.status as 'no_changes'|'failed'|'verification_failed'|'conflict');
   return {skipped:true};
  }
  const w=(await client.query<ExecutionWorkspaceRow & {host_owner:string|null;host_kind:string}>(`SELECT w.*,h.owner_user_id AS host_owner,h.kind AS host_kind FROM execution_workspaces w JOIN hosts h ON h.id=w.execution_host_id WHERE w.id=$1 AND w.space_id=$2`,[m.workspace_id,spaceId])).rows[0];
  if(!w||w.generation!==m.generation)throw new Error('integration_workspace_generation_changed');
  if(w.host_kind==='remote'&&w.host_owner!==m.requested_by_user_id)throw new Error('integration_host_authority_changed');
  await assertProjectWriterForMutation(client,spaceId,w.project_id,m.requested_by_user_id);
  const change=(await client.query<{state:string;summary:string|null;originating_run_id:string}>('SELECT state,summary,originating_run_id FROM workspace_change_sets WHERE id=$1 AND space_id=$2',[m.change_set_id,spaceId])).rows[0];
  if(!change||change.state==='abandoned')return {skipped:true};
  const visibleOrigin=await new PgRunRepository(client).getVisibleRun(spaceId,m.requested_by_user_id,change.originating_run_id);
  const origin=visibleOrigin?await completedWorkspaceRun(client,m.change_set_id,spaceId):null;
  if(!origin||!visibleOrigin||bodyWithheld(visibleOrigin.effective_access_level))throw new Error('integration_origin_no_longer_visible');
  await assertWorkspaceContributorsReadable(client,spaceId,m.requested_by_user_id,m.change_set_id);
  const originRunId=origin.id;
  const completedRepairs=()=>Array.isArray(m.detail_json.completed_repair_runs)?(m.detail_json.completed_repair_runs as unknown[]).filter((id):id is string=>typeof id==='string').slice(0,20):[];
  const ref=integrationWorkspaceReference(m),author=agentGitIdentity(origin.agent_id,null);
  const frame:Omit<HostRequestPayload<'workspace_integration'>,'action'>={workspace:{...await workspaceLocationFrame(client,w,ref,config.workspaceRoot),execution_workspace:{...ref,integration_id:m.attempt_id}},source_commit:m.source_commit,base_commit:m.base_commit,target_ref:m.target_ref,author,message:change.summary??'Integrated workspace change'};
  const request=(action:HostRequestPayload<'workspace_integration'>['action'],extra:Partial<HostRequestPayload<'workspace_integration'>>={})=>hosts.requestTaskBranch(w.execution_host_id,'workspace_integration',{...frame,...extra,action});
  async function save(status:string,detail:Record<string,unknown>={},extra:{onto?:string|null;candidate?:string|null;resolution?:string|null}={}){
   await client.query(`UPDATE task_merges SET status=$2,revision=revision+1,detail_json=detail_json||$3::jsonb,onto_commit=COALESCE($4,onto_commit),task_commit=COALESCE($5,task_commit),resolution_run_id=COALESCE($6,resolution_run_id),updated_at=now() WHERE id=$1 AND attempt_id=$7`,[m.id,status,JSON.stringify(detail),extra.onto??null,extra.candidate??null,extra.resolution??null,m.attempt_id]);
  }
  async function enqueueCandidateCleanup(commit:string|null|undefined,retainBranch:boolean){
   // A missing Host receipt is still an owned resource. Persist recovery before
   // closing/replacing this attempt; cleanup captures its tip before removal.
   await enqueueWorkspaceCleanup(client,w,ref,commit??m.task_commit??m.source_commit,retainBranch,m.requested_by_user_id,undefined,commit?undefined:{source_commit:m.source_commit,base_commit:m.base_commit,target_ref:m.target_ref,author});
  }
  async function block(status:'failed'|'conflict'|'verification_failed',detail:Record<string,unknown>){
   // Freeze failed resolution/verification output before any future cleanup.
   const evidence=await request('preserve');
   await transaction(async()=>{
    await save(status,{...detail,evidence_commit:evidence.candidate_commit,evidence_error:evidence.error});
    await client.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,updated_at=now() WHERE id=$1 AND state<>'abandoned'",[m.change_set_id]);
    await enqueueCandidateCleanup(evidence.ok?evidence.candidate_commit:null,true);
    await postWorkspaceIntegrationNotice(client,m.id,m.attempt_id,status);
   });
   await notifyParent();return {status};
  }
  async function notifyParent(){
   if(!w.parent_workspace_id)return;
   const parents=(await client.query<{run_id:string}>(`SELECT DISTINCT b.run_id FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=$1 AND r.status='waiting_for_dependency'`,[w.parent_workspace_id])).rows;
   for(const parent of parents)await new PgJobQueueRepository(client).enqueue({job_type:'execution_workspace_parent_reconcile',space_id:spaceId,user_id:m.requested_by_user_id,payload:{run_id:parent.run_id}});
  }
  async function finish(state:'integrated'|'no_changes',candidate:string|null){
   const inspected=candidate?null:await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:await workspaceLocationFrame(client,w,ref,config.workspaceRoot),action:'inspect',operation_id:randomUUID(),retain_branch:true});
   await transaction(async()=>{
    await save(state==='integrated'?'merged':'no_changes');
    await client.query('UPDATE task_merges SET merged_commit=$2,completed_at=now() WHERE id=$1',[m.id,candidate]);
    await client.query("UPDATE workspace_change_sets SET state=$2,revision=revision+1,verification_json=(verification_json-'error'-'checkpoint_recovery')||$3::jsonb,updated_at=now() WHERE id=$1",[m.change_set_id,state,JSON.stringify(m.detail_json.verification??{})]);
    if(w.parent_workspace_id&&candidate){
     const parent=(await client.query('UPDATE execution_workspaces SET head_commit=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND (head_commit IS NULL OR head_commit=$3 OR head_commit=$2) RETURNING id',[w.parent_workspace_id,candidate,m.onto_commit])).rowCount;
     if(parent)await client.query("UPDATE workspace_change_sets SET source_commit=$2,verification_json=CASE WHEN jsonb_typeof(verification_json->'adopted_child_change_ids')='array' THEN jsonb_set(verification_json,'{adopted_child_change_ids}',(verification_json->'adopted_child_change_ids')||to_jsonb($3::text),true) ELSE verification_json END,updated_at=now() WHERE workspace_id=$1 AND state IN ('open','ready')",[w.parent_workspace_id,candidate,m.change_set_id]);
     // A moved parent has uncertain adoption order. Keep legacy/concurrent
     // provenance conservative instead of claiming an exhaustive child list.
     else await client.query("UPDATE workspace_change_sets SET verification_json=verification_json-'adopted_child_change_ids',updated_at=now() WHERE workspace_id=$1 AND state IN ('open','ready')",[w.parent_workspace_id]);
    }
    const candidateTip=candidate??(inspected?.ok?inspected.commit:null);
    await enqueueCandidateCleanup(candidateTip,false);
    if(w.head_commit)await enqueueWorkspaceCleanup(client,w,{id:w.id,generation:w.generation},w.head_commit,true,m.requested_by_user_id);
    await postWorkspaceIntegrationNotice(client,m.id,m.attempt_id,state);
   });
   await notifyParent();return {status:state};
  }
  async function transaction(fn:()=>Promise<void>){
   await client.query('BEGIN');try{await fn();await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}
  }
  let repairOrigin:RunRecord|null=null;
  async function assertPublicationAuthority(){
   await assertWorkspaceContributorsReadable(client,spaceId,m.requested_by_user_id,m.change_set_id);
   if((await client.query("SELECT 1 FROM execution_workspaces w WHERE w.id=$1 AND (w.state IN ('blocked','retired') OR EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=$2 AND b.checkpoint_state<>'saved'))",[w.id,m.change_set_id])).rowCount)throw new Error('workspace_checkpoint_blocked');
   await assertProjectWriterForMutation(client,spaceId,w.project_id,m.requested_by_user_id);
   const host=(await client.query<{kind:string;owner_user_id:string|null}>('SELECT kind,owner_user_id FROM hosts WHERE id=$1',[w.execution_host_id])).rows[0];
   if(!host||host.kind==='remote'&&host.owner_user_id!==m.requested_by_user_id)throw new Error('integration_host_authority_changed');
   const runs=new PgRunRepository(client);
   for(const [runId,reason] of [[change!.originating_run_id,'integration_origin_no_longer_visible'],[originRunId,'integration_completion_no_longer_visible'],...(m.resolution_run_id?[[m.resolution_run_id,'integration_repair_no_longer_visible']]:[]),...completedRepairs().map(id=>[id,'integration_repair_no_longer_visible'])] as Array<[string,string]>){
    const visible=await runs.getVisibleRun(spaceId,m.requested_by_user_id,runId);
    if(!visible||bodyWithheld(visible.effective_access_level))throw new Error(reason);
   }
   repairOrigin=m.detail_json.agent_repair||m.detail_json.verification_request?await requestedWorkspaceRepairOrigin(client,m):null;
  }
  async function publicationTainted(){
   return workspacePublicationNeedsReview(client,{spaceId,changeSetId:m.change_set_id,requesterId:m.requested_by_user_id,repairRunId:m.resolution_run_id,instructionRunId:repairOrigin?.id,verificationRunIds:completedRepairs()});
  }
  // A frozen fast-forward/merge plan is never published here as a squash
  // (hosts.md, "Controlled Git publication"): the Host's finish publishes the
  // recorded chain itself, or the batch stays blocked with its evidence when
  // the chain was never recorded.
  const plan=frozenPublicationPlan(m.detail_json),chain=m.detail_json.publication as {chain_tip?:unknown;chain_length?:unknown}|undefined;
  let chainPublication:Partial<HostRequestPayload<'workspace_integration'>>={};
  if(requiresNativePublication(plan)){
   if(typeof chain?.chain_tip!=='string'||typeof chain.chain_length!=='number'||chain.chain_length<1)return block('failed',{error:'native_publication_chain_unrecorded'});
   chainPublication={publication_strategy:plan!.strategy,publication_chain_tip:chain.chain_tip,publication_chain_length:chain.chain_length};
  }
  const replyOwner=m.detail_json.reply_owner_run_id;
  if(typeof replyOwner==='string'){
   const owner=await new PgRunRepository(client).getRun(spaceId,replyOwner);
   if(owner&&['queued','running','cancelling','waiting_for_review','waiting_for_dependency'].includes(owner.status))throw new JobDeferredError('integration_owned_by_current_run',10000);
   return block('failed',{error:'integration_current_run_ended'});
  }
  await assertPublicationAuthority();
  if(await publicationTainted())return block('failed',{error:'workspace_egress_review_required'});
  if(m.status==='resolving'){
   const r=m.resolution_run_id?await new PgRunRepository(client).getRun(spaceId,m.resolution_run_id):null;
   if(r&&['queued','running','cancelling','waiting_for_review','waiting_for_dependency'].includes(r.status))throw new JobDeferredError('integration_repair_running',10000);
   if(!r||r.status!=='succeeded')return block(m.detail_json.repair_kind==='verification_setup'?'verification_failed':'conflict',{error:m.detail_json.repair_kind==='verification_setup'?'integration_agent_verification_failed':'integration_repair_failed'});
  }
  if(m.status!=='verifying'&&m.status!=='waiting_local_changes'){
   const reply=await request(m.status==='resolving'?'continue':'prepare');
   if(!reply.ok){
    if(['host_offline','host_disconnected','task_busy','location_busy'].some(s=>reply.error?.includes(s)))throw new JobDeferredError(reply.error!,30000);
    return block('failed',{error:reply.error});
   }
   if(reply.outcome==='no_changes'){
    if(reply.onto_commit)await save('rebasing',{already_present_at:reply.onto_commit},{onto:reply.onto_commit});
    return finish('no_changes',null);
   }
   if(m.detail_json.reconcile_only===true)return block(reply.outcome==='conflict'||reply.outcome==='unresolved'?'conflict':'failed',{error:'integration_not_yet_adopted',conflicted_files:reply.conflicted_files});
   if(reply.outcome==='conflict'||reply.outcome==='unresolved'){
    await save('rebasing',{conflicted_files:reply.conflicted_files},{onto:reply.onto_commit});
    // A fast-forward (and a rebase chain, fast-forwarded) publishes the recorded chain unchanged:
    // no repair here can make it apply to a moved target; a rebase is replayed again only in an Agent session.
    if(plan?.strategy==='fast_forward'||plan?.strategy==='rebase')return block('conflict',{error:'native_publication_fast_forward_target_moved',conflicted_files:reply.conflicted_files});
    const resolution=(m.detail_json.human_resolution??m.detail_json.agent_repair) as {instruction?:unknown;user_id?:unknown;paths?:unknown}|undefined;
    if(resolution){
     if(typeof resolution.instruction!=='string'||resolution.user_id!==m.requested_by_user_id||!Array.isArray(resolution.paths)||JSON.stringify([...resolution.paths].sort())!==JSON.stringify([...reply.conflicted_files].sort()))return block('conflict',{error:'integration_resolution_scope_changed',conflicted_files:reply.conflicted_files});
     const prepared=await request('repair',{repair_mode:repairOrigin?'agent_resolution':'user_resolution'});
     if(!prepared.ok&&workspaceHostFailureIsTemporary(prepared.error))throw new JobDeferredError(prepared.error??'host_unavailable',30000);
     if(!prepared.ok||JSON.stringify([...prepared.conflicted_files].sort())!==JSON.stringify([...reply.conflicted_files].sort()))return block('conflict',{error:'integration_resolution_unavailable',conflicted_files:reply.conflicted_files});
    }else {
     // Integration authorization includes Agent conflict repair. The Host still
     // freezes the exact conflicting paths and enforces capture/marker guards.
     const prepared=await request('repair',{repair_mode:'agent_resolution'});
     if(!prepared.ok&&workspaceHostFailureIsTemporary(prepared.error))throw new JobDeferredError(prepared.error!,30000);
     if(!prepared.ok||JSON.stringify([...prepared.conflicted_files].sort())!==JSON.stringify([...reply.conflicted_files].sort()))return block('conflict',{error:'integration_resolution_unavailable',conflicted_files:reply.conflicted_files});
    }
    if(m.resolution_run_id)return block('conflict',{error:'integration_repair_incomplete',conflicted_files:reply.conflicted_files});
    const repair=deps.repair??dispatchWorkspaceRepair;
    await client.query('BEGIN');
    try{
     const runId=await repair(client,pool,config,m,w,repairOrigin??origin,reply.conflicted_files);
     if(!runId){await client.query('ROLLBACK');return block('conflict',{error:'integration_repair_unavailable',conflicted_files:reply.conflicted_files});}
     await save('resolving',{conflicted_files:reply.conflicted_files,automatic_repairs:Number(m.detail_json.automatic_repairs??0)+1},{resolution:runId});
     await postWorkspaceIntegrationNotice(client,m.id,m.attempt_id,'repair_started');
     await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');deferIfSourceReleasePending(error);return block('conflict',{error:String(error),conflicted_files:reply.conflicted_files});}
    throw new JobDeferredError('integration_repair_dispatched',10000);
   }
   if(reply.outcome!=='rebased'||!reply.onto_commit||!reply.candidate_commit)return block('failed',{error:'integration_unexpected_prepare_answer'});
   m.onto_commit=reply.onto_commit;m.task_commit=reply.candidate_commit;
   await save('verifying',{}, {onto:m.onto_commit,candidate:m.task_commit});
   if(m.resolution_run_id){
    const completed=[...new Set([...completedRepairs(),m.resolution_run_id])];
    await client.query("UPDATE task_merges SET resolution_run_id=NULL,detail_json=detail_json||$2::jsonb WHERE id=$1 AND attempt_id=$3",[m.id,JSON.stringify({completed_repair_runs:completed}),m.attempt_id]);
    m.detail_json.completed_repair_runs=completed;m.resolution_run_id=null;
   }

  }
  if(!m.onto_commit||!m.task_commit)return block('failed',{error:'integration_candidate_missing'});
  if(m.status!=='waiting_local_changes'){
   const engine=new PgVerificationEngine(client,undefined,new HostCommandVerificationExecutor());
   const output=runOutputResult(origin.output_json);
   const frozenPrimary=LaunchWorkspaceSchema.safeParse(output.execution_workspace_location);
   const frozenAttachments=HostLaunchWorkspaceAccessSchema.array().safeParse(output.execution_workspace_access);
   if(!frozenPrimary.success||!frozenAttachments.success)return block('verification_failed',{error:'workspace_verification_layout_missing'});
   const primary=frozenPrimary.data,mounts=frozenAttachments.data;
   const matches=(mount:{workspace_location_id:string;execution_workspace?:ExecutionWorkspaceRef},workspace:ExecutionWorkspaceRow)=>mount.workspace_location_id===workspace.workspace_location_id&&mount.execution_workspace?.id===workspace.id&&mount.execution_workspace.generation===workspace.generation;
   const originalPrimary=primary.kind==='location'?primary:null;
   const candidateMount=originalPrimary&&matches(originalPrimary,w)?originalPrimary:mounts.find(mount=>matches(mount,w));
   if(!candidateMount)return block('verification_failed',{error:'workspace_verification_layout_missing'});
   const candidateRef=executionWorkspaceMountRef(ref,candidateMount.execution_workspace?.cwd_subpath);
   const candidateFrame=await workspaceLocationFrame(client,w,candidateRef,config.workspaceRoot);
   const verificationMounts:HostLaunchWorkspaceAccess[]=[];
   // Candidate aliases retain their actual mount identities, including an
   // explicit root scope which must clear a prior alias's cwd_subpath.
   for(const mount of mounts.filter(mount=>matches(mount,w)))verificationMounts.push({...candidateFrame,mount_location_id:mount.mount_location_id??mount.workspace_location_id,execution_workspace:executionWorkspaceMountRef(ref,mount.execution_workspace?.cwd_subpath),access_mode:'write'});
   const attachments=(await client.query<ExecutionWorkspaceRow & {checkpoint_commit:string|null;checkpoint_state:string;launch_reference_json:ExecutionWorkspaceRef|null}>(`SELECT other.*,b.checkpoint_commit,b.checkpoint_state,b.launch_reference_json FROM execution_workspace_runs b JOIN execution_workspaces other ON other.id=b.workspace_id WHERE b.run_id=$1 AND other.id<>$2`,[origin.id,w.id])).rows;
   for(const attachment of attachments){
    if(attachment.checkpoint_state!=='saved'||!attachment.checkpoint_commit)return block('verification_failed',{error:'workspace_attachment_checkpoint_missing'});
    const aliases=mounts.filter(mount=>matches(mount,attachment));
    if(originalPrimary&&matches(originalPrimary,attachment))aliases.push({...originalPrimary,mount_location_id:origin.workspace_location_id??originalPrimary.workspace_location_id,access_mode:'read'});
    if(!aliases.length)return block('verification_failed',{error:'workspace_verification_layout_missing'});
    const mirrorRef={id:attachment.id,generation:attachment.generation,integration_id:m.attempt_id};
    const mirrorFrame=await workspaceLocationFrame(client,attachment,mirrorRef,config.workspaceRoot);
    // Intent precedes Host allocation. A lost reply cannot orphan the mirror.
    const manifest=(await client.query<{cleanup_json:Record<string,unknown>}>('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[attachment.id])).rows[0]?.cleanup_json;
    if(!manifest?.[m.attempt_id])await enqueueWorkspaceCleanup(client,attachment,mirrorRef,attachment.checkpoint_commit,false,m.requested_by_user_id,m.id);
    const copied=await hosts.requestTaskBranch(attachment.execution_host_id,'execution_workspace_command',{workspace:mirrorFrame,action:'mirror',expected_commit:attachment.checkpoint_commit,operation_id:randomUUID(),retain_branch:true});
    if(!copied.ok){
     if(workspaceHostFailureIsTemporary(copied.error))throw new JobDeferredError(copied.error!,30000);
     return block('verification_failed',{error:copied.error??'workspace_verification_mirror_unavailable'});
    }
    for(const alias of aliases)verificationMounts.push({...mirrorFrame,mount_location_id:alias.mount_location_id??alias.workspace_location_id,execution_workspace:executionWorkspaceMountRef(mirrorRef,alias.execution_workspace?.cwd_subpath),access_mode:'read'});
   }
   const folder=await workspaceVerificationFolder(client,w,origin);
   if(!folder)return block('verification_failed',{error:'integration_source_folder_unavailable'});
   // Each repository supplies its own Folder recipe. A primary Folder's
   // contract-specific file checks must not run in an attachment repository.
   const verificationRun:RunRecord=folder.project_folder_id===origin.project_folder_id?origin:{...origin,project_folder_id:folder.project_folder_id,contract_snapshot_json:{source:{kind:'direct',id:null},project_id:w.project_id,project_folder_id:folder.project_folder_id}};
   let outcome=await (deps.verify??(i=>engine.verifyTaskWorkspace({...i,include_diagnostics:true})))({run:verificationRun,target:{host_id:w.execution_host_id,workspace:candidateFrame,workspace_access:verificationMounts},base_commit_sha:m.onto_commit});
   if(outcome.status==='not_required'){
    const basic=m.detail_json.agent_verification_basic as {attempt_id?:string;run_id?:string}|undefined;
    if(basic?.attempt_id===m.attempt_id&&basic.run_id&&completedRepairs().includes(basic.run_id)){
     outcome=await verifyBasicWorkspaceCandidate(hosts,{hostId:w.execution_host_id,runId:origin.id,workspace:candidateFrame,mounts:verificationMounts,onto:m.onto_commit,candidate:m.task_commit});
    }else if(m.detail_json.verification_setup_attempt!==m.attempt_id){
     const scope=await request('repair');
     if(!scope.ok&&workspaceHostFailureIsTemporary(scope.error))throw new JobDeferredError(scope.error!,30000);
     if(scope.ok&&scope.conflicted_files.length){
      const setup={...m,detail_json:{...m.detail_json,repair_kind:'verification_setup'}};
      await client.query('BEGIN');
      try{
       const runId=await (deps.repair??dispatchWorkspaceRepair)(client,pool,config,setup,w,repairOrigin??origin,scope.conflicted_files);
       if(runId){await save('resolving',{repair_kind:'verification_setup',verification_setup_attempt:m.attempt_id,completed_repair_runs:completedRepairs()},{resolution:runId});await postWorkspaceIntegrationNotice(client,m.id,m.attempt_id,'repair_started');await client.query('COMMIT');throw new JobDeferredError('integration_agent_verification_dispatched',10000);}
       await client.query('ROLLBACK');
      }catch(error){if(error instanceof JobDeferredError)throw error;await client.query('ROLLBACK');}
     }
     return block('verification_failed',{error:'integration_agent_verification_unavailable'});
    }else return block('verification_failed',{error:'integration_agent_verification_incomplete'});
   }
   const diagnostics=outcome.checks.flatMap(check=>check.diagnostics?[{key:check.key,output:check.diagnostics}]:[]);
   outcome={...outcome,checks:outcome.checks.map(({diagnostics:_,...check})=>check)};
   // Full output belongs only to the assigned repair, never shared progress.
   await save('verifying',{verification_diagnostics:diagnostics});
   if(outcome.status!=='passed'){
    if(outcome.status==='failed'&&!m.resolution_run_id&&Number(m.detail_json.verification_repairs??0)<limits.automaticRepairs){
     const scope=await request('repair');
     if(scope.ok&&scope.automatic_repair_allowed&&scope.conflicted_files.length){
      m.detail_json.checks=outcome.checks;
      await client.query('BEGIN');
      try{
       const runId=await (deps.repair??dispatchWorkspaceRepair)(client,pool,config,{...m,detail_json:{...m.detail_json,repair_kind:'verification'}},w,repairOrigin??origin,scope.conflicted_files);
       if(runId){await save('resolving',{checks:outcome.checks,conflicted_files:scope.conflicted_files,repair_kind:'verification',verification_repairs:Number(m.detail_json.verification_repairs??0)+1,completed_repair_runs:completedRepairs()},{resolution:runId});await postWorkspaceIntegrationNotice(client,m.id,m.attempt_id,'repair_started');await client.query('COMMIT');throw new JobDeferredError('integration_verification_repair_dispatched',10000);}
       await client.query('ROLLBACK');
      }catch(error){
       if(error instanceof JobDeferredError)throw error;
       await client.query('ROLLBACK');
      }
     }
    }
    return block('verification_failed',{error:'integration_verification_failed',checks:outcome.checks});
   }
   m.detail_json.verification={...outcome,source_commit:m.source_commit,candidate_commit:m.task_commit,target_commit:m.onto_commit};
   await save('verifying',{verification:m.detail_json.verification});
  }
  await assertPublicationAuthority();
  if(await publicationTainted())return block('failed',{error:'workspace_egress_review_required'});
  const sealed=await request('seal',{candidate_commit:m.task_commit});
  if(!sealed.ok)return block('verification_failed',{error:sealed.error});
  const publish=async()=>{
   // Folder acquisition and Host I/O may follow long-running verification.
   // Recheck the actual completion/repair and its taint immediately at publish.
   await assertPublicationAuthority();
   if(await publicationTainted())return {ok:false,outcome:null,main_branch:null,onto_commit:null,candidate_commit:null,conflicted_files:[],error:'workspace_egress_review_required'};
   return request('finish',{onto_commit:m.onto_commit!,candidate_commit:m.task_commit!,...chainPublication});
  };
  let reply:Awaited<ReturnType<typeof publish>>;
  if(!w.parent_workspace_id){
   const folder=(await client.query<{project_folder_id:string}>('SELECT project_folder_id FROM workspace_locations WHERE id=$1 AND space_id=$2',[w.workspace_location_id,spaceId])).rows[0];
   if(!folder)throw new Error('integration_source_folder_unavailable');
   // Share the established source-file critical section with durable code_patch
   // apply/compensation. Candidate construction and verification stay parallel.
   const gate=await tryWithDedicatedSessionAdvisoryLock(pool,`code-patch-folder:${folder.project_folder_id}`,publish);
   if(!gate.acquired)throw new JobDeferredError('integration_source_folder_busy',1000);
   reply=gate.value;
  }else reply=await publish();
  if(reply.ok&&reply.outcome==='merged')return finish('integrated',reply.candidate_commit??m.task_commit);
  if(reply.outcome==='main_moved'){
   const moves=Number(m.detail_json.target_moves??0)+1;
   if(moves>=limits.targetMoves)return block('failed',{error:'integration_target_keeps_moving',target_moves:moves});
   const evidence=await request('preserve');
   await transaction(async()=>{
    await enqueueCandidateCleanup(evidence.ok?evidence.candidate_commit:null,false);
    await client.query(`UPDATE task_merges SET status='queued',revision=revision+1,attempt_id=$2,onto_commit=NULL,task_commit=NULL,resolution_run_id=NULL,detail_json=$3::jsonb,updated_at=now() WHERE id=$1`,[m.id,randomUUID(),JSON.stringify({...frozenPublicationDetail(m.detail_json),target_moves:moves,automatic_repairs:Number(m.detail_json.automatic_repairs??0),...(m.detail_json.human_resolution?{human_resolution:m.detail_json.human_resolution}:{}),...(m.detail_json.agent_repair?{agent_repair:m.detail_json.agent_repair}:{}),...(m.detail_json.verification_request?{verification_request:m.detail_json.verification_request}:{}),...(m.detail_json.reply_owner_run_id?{reply_owner_run_id:m.detail_json.reply_owner_run_id}:{}),completed_repair_runs:completedRepairs(),verification_repairs:Number(m.detail_json.verification_repairs??0)})]);
   });
   throw new JobDeferredError('integration_target_moved',1000);
  }
  if(reply.outcome==='waiting_local_changes'){
   return block('failed',{error:'integration_waiting_local_changes',overlapping_files:reply.conflicted_files});
  }
  if(!reply.ok&&['busy','host_offline','host_disconnected','timeout','main_checked_out_elsewhere'].some(s=>reply.error?.includes(s)))throw new JobDeferredError(reply.error!,30000);
  return block('failed',{error:reply.error??'integration_unexpected_finish_answer'});
 }finally{
  if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{});
  client.release();
 }
}

/** Exhausted failures may have allocated a candidate before authority was lost.
 * Record capture intent without performing Host I/O under revoked authority. */
export async function failWorkspaceIntegration(db:Queryable,id:string,spaceId:string,error:string){
 await withQueryableTransaction(db,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`workspace-integration:${id}`]);
  const m=(await tx.query<WorkspaceIntegrationRow>('SELECT * FROM task_merges WHERE id=$1 AND space_id=$2 AND workspace_id IS NOT NULL FOR UPDATE',[id,spaceId])).rows[0];
  if(!m||['merged','no_changes','superseded','failed','conflict','verification_failed'].includes(m.status))return;
  const w=(await tx.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1',[m.workspace_id])).rows[0];
  if(w){
   // enqueueWorkspaceCleanup freezes repair profile ownership on this attempt.
   await enqueueWorkspaceCleanup(tx,w,integrationWorkspaceReference(m),m.task_commit??m.source_commit,true,m.requested_by_user_id,undefined,
    {source_commit:m.source_commit,base_commit:m.base_commit,target_ref:m.target_ref,author:agentGitIdentity(null,null)});
  }
  await tx.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||$3::jsonb WHERE id=$1 AND space_id=$2 AND state<>'abandoned'",[m.change_set_id,spaceId,JSON.stringify({error:'integration_retry_exhausted'})]);
  await tx.query("UPDATE task_merges SET status='failed',revision=revision+1,detail_json=detail_json||$2::jsonb,updated_at=now() WHERE id=$1",[id,JSON.stringify({error,evidence_error:'workspace_candidate_capture_pending'})]);
  await postWorkspaceIntegrationNotice(tx,m.id,m.attempt_id,'failed');
 });
}
