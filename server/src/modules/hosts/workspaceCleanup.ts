import {workspaceHostFailureIsTemporary} from '../projectFolders/workspacePolicy.js';
import {workspaceLocationFrame,workspaceProfileFrame} from './workspaceLocation.js';
import {randomUUID} from 'node:crypto';
import type {ExecutionWorkspaceRef} from '@rainver/protocol';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {JobDeferredError,type JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry,type HostRequestPayload} from './connectionRegistry.js';
import type {ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {assessWorkspaceRetention,hostReleasesRefs,recordRetention,reclaimProofCommits,reclaimBaseCommits,runHistoryCommits,refReleasePlan,localPreimageReleases,workspaceRetentionSettings,REF_RELEASE_PAGE,type RefRelease} from './workspaceRetention.js';
import {advanceRefRelease,enqueueRefRelease,sameRelease,type DelayedRefKind,type RefInflight} from './workspaceRefRelease.js';

export interface WorkspaceCleanupResource {
 kind?:'legacy_profiles'|DelayedRefKind;legacy_agent_id?:string;legacy_container_id?:string;
 version:1;operation_id:string;workspace:ExecutionWorkspaceRef;expected_commit:string;
 retain_branch:boolean;state:'pending'|'running'|'retry_wait'|'blocked'|'cleaned';attempts:number;
 error:string|null;next_retry_at:string|null;profile_agents?:string[];profile_run_ids?:string[];profile_thread_run_ids?:string[];profiles_archived?:boolean;owner_integration_id?:string;
 capture?:Pick<HostRequestPayload<'workspace_integration'>,'source_commit'|'base_commit'|'target_ref'|'author'>;
 /** Branch release: the materialization epoch being released; the row was raised past it before sending. */
 release_epoch?:number;reclaim_proof?:string[];reclaim_bases?:string[];history_commits?:string[];release_refs?:RefRelease[];
 /** Refs of the proven release beyond the first frame, and the owned-ref cursor
  * after the first Host page (null: no further page). Continued by `ref_pages`. */
 release_rest?:RefRelease[];owned_after?:string|null;retained_count?:number;
 /** `ref_pages`: the visible reason recorded when the last page finishes the release. */
 reason_on_finish?:'merged'|'no_changes';
 /** The release's own id, fixed when its epoch is raised (a retry's new operation id keeps it); with `release_epoch`, its full identity. */
 release_id?:string;
 /** A newer materialization made this request obsolete; nothing was removed by it. */
 superseded?:boolean;
 /** Delayed/paged ref release: the claimed Host operation not yet confirmed (see workspaceRefRelease). */
 inflight?:RefInflight;
 /** run_history: Run-history pages still to read from the Host (cursor), with the due time and epoch of the release that reported them. */
 history_scan?:{after:string;due_at:string;epoch:number};
 /** Ref work blocked as unconfirmed: the Host's ref protocol level then (absent: written before it was recorded). */
 blocked_host_level?:number;
 /** Ref work paused for a Host below this `execution_workspaces.reclaim` level (host_upgrade_required). */
 required_host_level?:number;
 /**
  * Commits this generation keeps under `refs/rainver/source-keepers/<id>/g<n>/<c>`
  * (a settle protected them before ending an earlier deletion). The resource owns
  * removing them and is never `cleaned` while one remains; each is dropped only by
  * the operation that restores its shared `sources` ref.
  */
 keepers?:string[];
 /** `workspace_source_lost_before_fence`: dependent commits whose object was already gone when the settle first reached them. */
 lost_sources?:string[];
}
/**
 * `at` overrides when the Job first looks: `now` for an explicit or already
 * eligible release, a time for a known grace end. By default a source Job
 * first looks after the short grace since the last Run exit.
 */
export async function enqueueWorkspaceCleanup(db:Queryable,w:ExecutionWorkspaceRow,ref:ExecutionWorkspaceRef,expected:string,retainBranch:boolean,userId:string,ownerIntegrationId?:string,capture?:WorkspaceCleanupResource['capture'],at?:Date|'now'){
 const key=ref.integration_id??`source-g${ref.generation}`;
 const resource:WorkspaceCleanupResource={version:1,operation_id:randomUUID(),workspace:ref,expected_commit:expected,
  ...(ownerIntegrationId?{owner_integration_id:ownerIntegrationId}:{}),...(capture?{capture}:{}),retain_branch:retainBranch,state:'pending',attempts:0,error:null,next_retry_at:null};
 if(ref.integration_id){
  const profiles=(await db.query<{id:string;agent_id:string;inline:boolean}>(`SELECT DISTINCT r.id,r.agent_id,r.id IS NOT DISTINCT FROM m.detail_json->>'reply_owner_run_id' AS inline FROM task_merges m JOIN runs r ON r.space_id=m.space_id AND ((r.id=m.detail_json->>'reply_owner_run_id' AND m.attempt_id=$2) OR (r.id=m.resolution_run_id AND m.attempt_id=$2) OR (r.contract_snapshot_json->>'workspace_integration_id'=m.id AND r.contract_snapshot_json->>'workspace_integration_attempt_id'=$2)) WHERE m.workspace_id=$1 AND r.agent_id IS NOT NULL`,[w.id,ref.integration_id])).rows;
  resource.profile_agents=[...new Set(profiles.map(r=>r.agent_id))];resource.profile_run_ids=profiles.map(r=>r.id);resource.profile_thread_run_ids=profiles.filter(r=>!r.inline).map(r=>r.id);
 }
 // Every attempt has its own resource key. Replacing a source cleanup is safe:
 // its operation id fences an older Job, and its expected tip fences the Host.
 await db.query(`UPDATE execution_workspaces SET cleanup_state='pending',cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true),updated_at=now() WHERE id=$1`,[w.id,key,JSON.stringify(resource)]);
 await refreshCleanupSummary(db,w.id);
 // First look after the short grace: a proven merged/unchanged source is
 // released then; retained work learns its reason and waits for the idle rule.
 const idleAfter=at==='now'?undefined:at?at:!ref.integration_id&&w.owner_kind==='conversation'?(await db.query<{idle_after:Date}>("SELECT MAX(COALESCE(run.ended_at,run.updated_at))+make_interval(secs=>$2::float8/1000) AS idle_after FROM execution_workspace_runs b JOIN runs run ON run.id=b.run_id WHERE b.workspace_id=$1",[w.id,workspaceRetentionSettings.graceMs])).rows[0]?.idle_after:undefined;
 await new PgJobQueueRepository(db).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:userId,
  payload:{workspace_id:w.id,resource_key:key,operation_id:resource.operation_id},
  scheduled_at:idleAfter?new Date(idleAfter):undefined});
}
/**
 * A source cleanup that may be replaced (and so fenced) by a fresh one: none
 * yet, finished, or still waiting on a timer. A running request or a release
 * already issued (epoch raised) is never replaced; it finishes or is retried.
 */
export function replaceableSourceCleanup(source:WorkspaceCleanupResource|undefined){
 return !source||source.state==='cleaned'||(source.state==='pending'||source.state==='retry_wait')&&source.release_epoch===undefined
  // The Host refuses every release side effect beside a whole-tree quarantine,
  // so such a blocked request removed nothing and a fresh one may follow it.
  ||source.state==='blocked'&&source.error==='workspace_quarantined';
}
export async function advanceWorkspaceCleanup(db:Queryable,workspaceId:string,key:string,operationId:string,userId:string,hosts:HostConnectionRegistry=sharedHostConnectionRegistry,workspaceRoot?:string){
 const w=(await db.query<ExecutionWorkspaceRow & {cleanup_json:Record<string,WorkspaceCleanupResource>;host_owner:string|null;host_kind:string;host_reclaim:number|null;materialization_epoch:number}>(`SELECT w.*,h.owner_user_id AS host_owner,h.kind AS host_kind,(h.capabilities_json->'execution_workspaces'->>'reclaim')::int AS host_reclaim FROM execution_workspaces w JOIN hosts h ON h.id=w.execution_host_id WHERE w.id=$1`,[workspaceId])).rows[0];
 const r=w?.cleanup_json[key];
 if(!w||!r||r.operation_id!==operationId||r.state==='cleaned')return {skipped:true};
 if(r.state==='blocked'&&r.attempts>=8)return {blocked:true};
 // A release issued for an older epoch: the newer materialization owns its own cleanup.
 // Its remaining ref pages still finish: the Host keeps what a rebuild may own,
 // and the pages only touch refs owned by that release's closed facts.
 if(r.release_epoch!==undefined&&r.kind!=='ref_pages'&&w.materialization_epoch!==r.release_epoch+1){await save({...r,state:'cleaned',superseded:true,error:null,next_retry_at:null});return {superseded:true};}
 if(r.kind==='local_preimages'||r.kind==='run_history'||r.kind==='ref_pages')return advanceRefRelease(db,w,key,r,userId,hosts,workspaceRoot,save);
 let releasing=false;
 if(r.owner_integration_id&&(await db.query("SELECT 1 FROM task_merges WHERE id=$1 AND status IN ('queued','rebasing','resolving','verifying','waiting_local_changes')",[r.owner_integration_id])).rowCount)throw new JobDeferredError('workspace_verification_mirror_in_use',30000);

 const inUse=(await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id
   WHERE b.workspace_id=$1 AND r.status IN ('running','queued','cancelling') LIMIT 1`,[w.id])).rowCount;
 if(!r.workspace.integration_id&&r.kind!=='legacy_profiles'&&inUse)throw new JobDeferredError('workspace_cleanup_run_active',30000);
 if(!r.workspace.integration_id&&r.kind!=='legacy_profiles'){
  if(r.workspace.id!==w.id||r.workspace.generation!==w.generation)return {skipped:true};
  const unsettled=(await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs run ON run.id=b.run_id
   JOIN workspace_change_sets c ON c.id=b.change_set_id WHERE b.workspace_id=$1 AND
   (run.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review') OR
    (b.checkpoint_state<>'saved' AND NOT(b.checkpoint_state='blocked' AND c.state='abandoned'))) LIMIT 1`,[w.id])).rowCount;
  if(unsettled)throw new JobDeferredError('workspace_cleanup_checkpoint_owed',30000);
  if((await db.query("SELECT 1 FROM task_merges WHERE workspace_id=$1 AND status IN ('queued','rebasing','resolving','verifying','waiting_local_changes') LIMIT 1",[w.id])).rowCount)
   throw new JobDeferredError('workspace_cleanup_integration_active',30000);
  // A release already issued (epoch raised, maybe executed) is finished, not
  // re-judged: its visible state stays `reclaiming` until the reply settles it.
  if(r.release_epoch!==undefined)releasing=true;
  else{
  const assessment=await assessWorkspaceRetention(db,w.id);
  // The assessment gates only branch/ref release. Physical-only reclamation of
  // other states keeps its existing guards and idle rule.
  await recordRetention(db,w.id,{state:assessment.state,reason:assessment.reason,reclaim_after:assessment.reclaim_after});
  // Waiting for the grace or a person's hold is not a failed request.
  if(assessment.state==='grace'||assessment.state==='held')throw new JobDeferredError(`workspace_cleanup_${assessment.state}`,Math.max(1000,(Date.parse(assessment.reclaim_after??'')-Date.now())||30000));
  releasing=assessment.state==='reclaimable'&&hostReleasesRefs(w.host_reclaim);
  if(assessment.state==='reclaimable'&&!releasing)await recordRetention(db,w.id,{state:'retained',reason:'host_upgrade_required'});
  if(!releasing&&w.owner_kind==='conversation'){
   // Retained work keeps its branch; only its physical tree follows the idle rule.
   const activity=(await db.query<{wait_ms:number}>(`SELECT GREATEST(0,EXTRACT(EPOCH FROM (MAX(run.updated_at)+interval '24 hours'-now()))*1000)::float8 AS wait_ms
    FROM execution_workspace_runs b JOIN runs run ON run.id=b.run_id WHERE b.workspace_id=$1`,[w.id])).rows[0];
   if(activity?.wait_ms>0)throw new JobDeferredError('workspace_cleanup_idle_period',Math.ceil(activity.wait_ms));
  }
  }
 }
 const next={...r,state:'running' as const,attempts:r.attempts+1};
 await save(next);
 let reply:import('./connectionRegistry.js').TaskBranchReply<'execution_workspace_command'>;
 try{
  if(w.host_kind==='remote'&&w.host_owner!==userId)throw new Error('workspace_cleanup_host_authority_changed');
  await assertProjectWriterForMutation(db,w.space_id,w.project_id,userId);
  if(r.kind==='legacy_profiles'){
   if(!r.legacy_agent_id||!r.legacy_container_id)throw new Error('workspace_legacy_profile_identity_missing');
   const answer=await hosts.requestManagedWorkspaceAction(w.execution_host_id,'managed_workspace_archive',{agent_id:r.legacy_agent_id,container_kind:'conversation',container_id:r.legacy_container_id,include_workspace:false});
   if(!answer.ok)throw hostFailure(answer.error??'workspace_legacy_profile_archive_failed');
   await save({...next,state:'cleaned',error:null,next_retry_at:null});return {cleanup_state:'cleaned'};
  }
  if(r.profile_agents?.length&&!r.profiles_archived){
   const active=(await db.query(`SELECT 1 FROM runs run WHERE run.space_id=$3 AND (run.id=ANY($4::varchar[]) OR EXISTS(SELECT 1 FROM task_merges m WHERE m.workspace_id=$1 AND m.attempt_id=$2 AND m.resolution_run_id=run.id)) AND run.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review')`,[w.id,r.workspace.integration_id,w.space_id,r.profile_run_ids??[]])).rowCount;
   if(active)throw new JobDeferredError('workspace_profile_run_active',30000);
   const archived=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:await workspaceProfileFrame(db,w,r.workspace,userId),action:'archive_profiles',operation_id:r.operation_id,profile_agents:r.profile_agents,retain_branch:true});
   if(!archived.ok)throw hostFailure(archived.error??'workspace_profiles_archive_failed');
   next.profiles_archived=true;
   await db.query(`UPDATE host_threads SET status='closed',vendor_session_id=NULL,pending_archive_at=NULL,updated_at=now() WHERE execution_host_id=$3 AND id IN (SELECT run.host_task_thread_id FROM runs run WHERE run.space_id=$4 AND (run.id=ANY($5::varchar[]) OR EXISTS(SELECT 1 FROM task_merges m WHERE m.workspace_id=$1 AND m.attempt_id=$2 AND m.resolution_run_id=run.id)))`,[w.id,r.workspace.integration_id,w.execution_host_id,w.space_id,r.profile_thread_run_ids??r.profile_run_ids??[]]);
   await save(next);
  }
  if(next.capture){
   if(!r.workspace.integration_id)throw new Error('workspace_capture_integration_required');
   const workspace={...await workspaceLocationFrame(db,w,r.workspace,workspaceRoot,userId),execution_workspace:{...r.workspace,integration_id:r.workspace.integration_id}};
   const captured=await hosts.requestTaskBranch(w.execution_host_id,'workspace_integration',{...next.capture,workspace,action:'preserve',message:'Preserved integration candidate'});
   if(!captured.ok&&workspaceHostFailureIsTemporary(captured.error))throw hostFailure(captured.error!);
   if(!captured.ok||!captured.candidate_commit){
    const inspected=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace,action:'inspect',operation_id:r.operation_id,retain_branch:true});
    const i=inspected.inventory;
    if(!inspected.ok&&workspaceHostFailureIsTemporary(inspected.error))throw hostFailure(inspected.error!);
    if(inspected.ok&&i?.active)throw new JobDeferredError('workspace_candidate_in_use',30000);
    if(!inspected.ok||!i||i.branch||i.worktree||i.registration||i.run_record||i.merge_record||i.quarantined_whole>0)throw new Error(captured.error??'workspace_evidence_capture_required');
    // A failure before allocation leaves no candidate to capture or reclaim.
    await db.query('UPDATE execution_workspaces SET inventory_json=$2::jsonb WHERE id=$1',[w.id,JSON.stringify(i)]);
    delete next.capture;await save({...next,state:'cleaned',error:null,next_retry_at:null});return {cleanup_state:'cleaned'};
   }
   next.expected_commit=captured.candidate_commit;delete next.capture;await save(next);
  }
  const frame=await workspaceLocationFrame(db,w,r.workspace,workspaceRoot);
  if(!r.workspace.integration_id){
   // A newer checkpoint/sync supersedes only this exact source-generation request.
   // The fresh operation id fences late replies; Host CAS/lease still fence deletion.
   const observed=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:frame,action:'inspect',operation_id:randomUUID(),retain_branch:true});
   const left=observed.inventory;
   // A release already issued resumes with the same frame: the Host journal
   // finishes ref/receipt release even when the branch is already gone.
   // Only a release whose branch is provably gone resumes past the guards; an
   // issued release that never reached the Host (busy, timeout) is re-judged.
   const resuming=next.release_epoch!==undefined&&observed.ok&&Boolean(left)&&!left?.active&&!left?.branch&&!observed.commit;
   // Without a branch there is nothing to prove, but a release still owes its
   // refs, receipts and preimages: only a physical-only request may stop here.
   if(!resuming&&!releasing&&observed.ok&&!observed.commit&&left&&!left.branch&&!left.worktree&&!left.registration&&!left.run_record&&!left.merge_record&&left.quarantined_whole===0){
    // Nothing physical and no branch remain (an earlier release finished).
    await save({...next,state:'cleaned',error:null,next_retry_at:null},async tx=>{
     await tx.query('UPDATE execution_workspaces SET inventory_json=$2::jsonb WHERE id=$1',[w.id,JSON.stringify(left)]);
    });
    return {cleanup_state:'cleaned'};
   }
   const absent=releasing&&observed.ok&&!observed.commit&&Boolean(left)&&!left!.branch;
   if(!resuming&&(!observed.ok||!observed.commit&&!absent||!observed.inventory))throw hostFailure(observed.error??'workspace_cleanup_tip_unavailable');
   if(observed.inventory?.active)throw new JobDeferredError('workspace_cleanup_run_active',30000);
   if(!resuming&&releasing&&observed.inventory!.quarantined_whole>0){
    releasing=false;await recordRetention(db,w.id,{state:'retained',reason:'quarantined'});
    // An issued release whose branch is still there becomes physical-only: its
    // raised epoch is harmless (later launches carry a newer one).
    if(next.release_epoch!==undefined){
     for(const field of ['release_epoch','release_id','reclaim_proof','reclaim_bases','history_commits','release_refs','release_rest','owned_after','retained_count'] as const)delete next[field];
     next.retain_branch=true;await save(next);
    }
   }
   if(!resuming&&!absent&&observed.commit!==next.expected_commit){
    await withQueryableTransaction(db,async tx=>{
     const current=(await tx.query<{cleanup_json:Record<string,WorkspaceCleanupResource>;generation:number}>('SELECT cleanup_json,generation FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
     if(current?.generation===r.workspace.generation&&current.cleanup_json[key]?.operation_id===operationId)
      await enqueueWorkspaceCleanup(tx,w,r.workspace,observed.commit!,r.retain_branch,userId);
    });
    return {superseded:true};
   }
   if(releasing&&next.release_epoch===undefined){
    // Re-assess under the row lock and raise the epoch before sending: a launch
    // admitted from now on carries the newer epoch, so this request can never
    // remove that rebuilt materialization, even at the same tip.
    const plan=await refReleasePlan(db,w,observed.inventory!.owned_refs??[]);
    const proof=await reclaimProofCommits(db,w.id,w.generation),bases=await reclaimBaseCommits(db,w.id,w.generation),history=await runHistoryCommits(db,w.id,w.generation);
    const releaseId=randomUUID();
    const raised=await withQueryableTransaction(db,async tx=>{
     const row=(await tx.query<{materialization_epoch:number;cleanup_json:Record<string,WorkspaceCleanupResource>;generation:number}>('SELECT materialization_epoch,cleanup_json,generation FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
     if(!row||row.generation!==r.workspace.generation||row.cleanup_json[key]?.operation_id!==operationId)return null;
     if((await assessWorkspaceRetention(tx,w.id)).state!=='reclaimable')return null;
     await tx.query('UPDATE execution_workspaces SET materialization_epoch=materialization_epoch+1 WHERE id=$1',[w.id]);
     // The release's identity: a page run or reply of another release never finishes this one.
     await recordRetention(tx,w.id,{state:'reclaiming',reason:'reclaiming',retained_refs:plan.retained,release_epoch:row.materialization_epoch,release_id:releaseId});
     return row.materialization_epoch;
    });
    if(raised===null)throw new JobDeferredError('workspace_cleanup_state_changed',30000);
    Object.assign(next,{retain_branch:false,release_epoch:raised,release_id:releaseId,reclaim_proof:proof,reclaim_bases:bases,history_commits:history,
     // Shared sources go only as re-checked pages, never from this snapshot.
     release_refs:plan.release.slice(0,REF_RELEASE_PAGE),release_rest:[...plan.release.slice(REF_RELEASE_PAGE),...plan.sources],owned_after:observed.inventory!.owned_refs_next??null,retained_count:plan.shared_retained});
    w.materialization_epoch=raised+1;
    await save(next);
   }
  }

  const sendRef=next.release_epoch!==undefined?{...r.workspace,...(w.target_ref?{target_ref:w.target_ref}:{}),materialization_epoch:next.release_epoch}:r.workspace;
  reply=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{
    workspace:{...frame,execution_workspace:sendRef},action:'cleanup',operation_id:r.operation_id,expected_commit:next.expected_commit,retain_branch:next.retain_branch,
    ...(next.release_epoch!==undefined?{reclaim_proof:next.reclaim_proof??[],reclaim_bases:next.reclaim_bases??[],history_commits:next.history_commits??[],release_refs:next.release_refs??[]}:{})});
  if(reply.inventory)await db.query(`UPDATE execution_workspaces SET inventory_json=$2::jsonb WHERE id=$1`,[w.id,JSON.stringify(reply.inventory)]);
 }catch(error){
  if(error instanceof JobDeferredError){await defer(error);}
  reply={ok:false,error:String(error),branch:null,commit:null};
 }
 // Every Run-history ref the Host reports for a release gets its expiry,
 // whatever the reply: a release that stopped part-way, is retried, blocked or
 // superseded never leaves a created history ref without one. Merging is idempotent.
 // The reply carries one bounded page; a cursor makes the history resource
 // read the remaining pages (durably) before it deletes anything.
 let historyUntil:Date|null=null;
 const releasedInventory=next.release_epoch!==undefined?reply.inventory:undefined;
 const reportedHistory=releasedInventory?.history_refs??[],historyNext=releasedInventory?.history_refs_next??null;
 if(reportedHistory.length||historyNext){
  const due=new Date(Date.now()+workspaceRetentionSettings.runHistoryRetentionMs);
  historyUntil=await withQueryableTransaction(db,async tx=>(await enqueueRefRelease(tx,w,'run_history',historyReleases(w,reportedHistory,releasedInventory?.history_epochs??{},next.release_epoch!),userId,due,
   historyNext?{history_scan:{after:historyNext,due_at:due.toISOString(),epoch:next.release_epoch!}}:{})).until);
 }
 if(!reply.ok&&workspaceHostFailureIsTemporary(reply.error))await defer(new JobDeferredError(reply.error!,30000));
 if(!reply.ok&&reply.error==='workspace_materialization_moved'){
  // The Host admitted a newer materialization first; this request is obsolete.
  await save({...next,state:'cleaned',superseded:true,error:null,next_retry_at:null});
  return {superseded:true};
 }
 const branchRetained=reply.inventory?.branch_retained_reason;
 const proven=reply.inventory&&(next.retain_branch||!reply.inventory.branch||Boolean(branchRetained))&&!reply.inventory.worktree&&!reply.inventory.registration&&!reply.inventory.run_record&&!reply.inventory.merge_record&&reply.inventory.quarantined_whole===0;

 const state=reply.ok&&reply.cleanup_state==='cleaned'&&proven?'cleaned':reply.cleanup_state==='blocked'||next.attempts>=8?'blocked':'retry_wait';
 const updated={...next,state,error:reply.error??(state==='cleaned'?null:'workspace_cleanup_incomplete'),next_retry_at:state==='retry_wait'?new Date(Date.now()+Math.min(3600000,30000*2**next.attempts)).toISOString():null} as WorkspaceCleanupResource;
 await save(updated,next.release_epoch===undefined||state!=='cleaned'?undefined:async tx=>{
  const current=(await tx.query<{materialization_epoch:number;baseline_mode:string|null;retention_state:string|null;epoch:string|null;release_id:string|null}>("SELECT materialization_epoch,baseline_mode,retention_json->>'state' AS retention_state,retention_json->>'release_epoch' AS epoch,retention_json->>'release_id' AS release_id FROM execution_workspaces WHERE id=$1 FOR UPDATE",[w.id])).rows[0];
  if(current?.materialization_epoch!==next.release_epoch!+1)return;
  // Refs kept: the server plan's shared dependents, Host refusals, and owned refs left on the Host page.
  // Owned refs past the first page's cursor are the next page's to judge, not counted here.
  const leftOwned=(reply.inventory?.owned_refs??[]).filter(o=>typeof next.owned_after!=='string'||o.ref<=next.owned_after).length;
  const kept=(next.retained_count??0)+(reply.inventory?.retained_refs?.length??0)+leftOwned;
  // A launch recorded after this release went out owns the visible state now;
  // this late reply only finishes its own bookkeeping.
  const currentRelease=current.retention_state==='reclaiming'&&sameRelease(current,next.release_epoch,next.release_id);
  if(branchRetained){
   // The Host's Git proof did not support the release: the branch stays, visibly.
   const reason=current.baseline_mode==='snapshot'?'private_baseline':branchRetained==='workspace_reclaim_unproven'?'unmerged_source':branchRetained;
   if(currentRelease)await recordRetention(tx,w.id,{state:'retained',reason,retained_refs:kept,proof_refused_tip:next.expected_commit,proof_refused_reason:reason,proof_refused_at:new Date().toISOString()});
   return;
  }
  const merged=Boolean((await tx.query("SELECT 1 FROM task_merges WHERE workspace_id=$1 AND status='merged' LIMIT 1",[w.id])).rowCount);
  const more=Boolean(next.release_rest?.length)||typeof next.owned_after==='string';
  const history=reply.inventory?.history_refs??[];
  const facts={retained_refs:kept,reclaim_requested_at:null,history_refs:history.length,history_until:(history.length||historyNext)&&historyUntil?historyUntil.toISOString():null};
  if(currentRelease)await recordRetention(tx,w.id,more?{state:'reclaiming',reason:'releasing_refs',...facts}:{state:'reclaimed',reason:merged?'merged':'no_changes',...facts,reclaimed_at:new Date().toISOString()});
  else await recordRetention(tx,w.id,{retained_refs:kept,history_refs:history.length,history_until:facts.history_until});
  // The rest of the release continues now, page by page, from the owned-ref cursor.
  // Its pages carry this release's epoch: the Host keeps owned-by-name refs a rebuild may own.
  if(more)await enqueueRefRelease(tx,w,'ref_pages',next.release_rest??[],userId,new Date(),{owned_after:next.owned_after??null,retained_count:kept,workspace:r.workspace,release_epoch:next.release_epoch!,...(next.release_id?{release_id:next.release_id}:{}),reason_on_finish:merged?'merged':'no_changes'});
  const preimages=await localPreimageReleases(tx,w.id,w.generation);
  if(preimages.length)await enqueueRefRelease(tx,w,'local_preimages',preimages,userId,new Date(Date.now()+workspaceRetentionSettings.localPreimageRetentionMs));
  await refreshCleanupSummary(tx,w.id);
 });
 if(next.release_epoch!==undefined&&state==='blocked')await withQueryableTransaction(db,async tx=>{
  const current=(await tx.query<{materialization_epoch:number;retention_state:string|null}>("SELECT materialization_epoch,retention_json->>'state' AS retention_state FROM execution_workspaces WHERE id=$1 FOR UPDATE",[w.id])).rows[0];
  if(current?.materialization_epoch!==next.release_epoch!+1)return;
  // A quarantine stopped the release before any side effect: visibly retained, not `reclaiming`.
  if(current.retention_state==='reclaiming'&&(reply.inventory?.quarantined_whole??0)>0)await recordRetention(tx,w.id,{state:'retained',reason:'quarantined'});
  // History refs the Host already kept got their expiry above, even though the release stopped.
  if(historyUntil)await recordRetention(tx,w.id,{history_refs:reportedHistory.length,history_until:historyUntil.toISOString()});
  await refreshCleanupSummary(tx,w.id);
 });
 if(state==='retry_wait')throw new JobDeferredError(updated.error!,new Date(updated.next_retry_at!).getTime()-Date.now());
 return {cleanup_state:state};
 async function defer(error:JobDeferredError):Promise<never>{
  // Waiting for an active lease/profile is not a failed cleanup request.
  // Preserve any completed archival step without consuming the retry budget.
  await save({...next,state:'retry_wait',attempts:r.attempts,error:error.message,next_retry_at:new Date(Date.now()+error.retryAfterMs).toISOString()});
  throw error;
 }
 async function save(resource:WorkspaceCleanupResource,also?:(tx:Queryable)=>Promise<void>){
  await withQueryableTransaction(db,async tx=>{
   const saved=await tx.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true),updated_at=now()
    WHERE id=$1 AND cleanup_json->$2->>'operation_id'=$4`,[workspaceId,key,JSON.stringify(resource),operationId]);
   await refreshCleanupSummary(tx,workspaceId);
   if(saved.rowCount&&also)await also(tx);
  });
 }
}
export function registerWorkspaceCleanupJobs(registry:JobHandlerRegistry,db:Queryable,hosts=sharedHostConnectionRegistry,workspaceRoot?:string){
 registry.register('execution_workspace_cleanup',async job=>{
  if(!job.user_id)throw new Error('workspace_cleanup_actor_missing');
  return advanceWorkspaceCleanup(db,String(job.payload.workspace_id),String(job.payload.resource_key),String(job.payload.operation_id),job.user_id,hosts,workspaceRoot);
 });
}


export async function refreshCleanupSummary(db:Queryable,workspaceId:string){
   await db.query(`UPDATE execution_workspaces SET cleanup_state=CASE
     WHEN EXISTS(SELECT 1 FROM jsonb_each(cleanup_json) r WHERE r.value->>'state'='blocked') THEN 'blocked'
     WHEN EXISTS(SELECT 1 FROM jsonb_each(cleanup_json) r WHERE r.value->>'state'='retry_wait') THEN 'retry_wait'
     WHEN NOT EXISTS(SELECT 1 FROM jsonb_each(cleanup_json) r WHERE r.value->>'state'<>'cleaned' AND NOT(COALESCE(r.value->>'kind','') IN ('local_preimages','run_history') AND r.value->>'state'='pending')) THEN 'cleaned'
     ELSE 'pending' END WHERE id=$1`,[workspaceId]);
}

/** A cutover detaches the old cache; archive it without touching the Conversation cwd. */
export async function enqueueLegacyWorkspaceProfileArchive(db:Queryable,w:ExecutionWorkspaceRow,agentId:string,sessionId:string,userId:string){
 const key=`legacy-profile:${agentId}`;
 const existing=(await db.query('SELECT 1 FROM execution_workspaces WHERE id=$1 AND cleanup_json ? $2',[w.id,key])).rowCount;
 if(existing)return;
 const r:WorkspaceCleanupResource={version:1,kind:'legacy_profiles',legacy_agent_id:agentId,legacy_container_id:sessionId,operation_id:randomUUID(),workspace:{id:w.id,generation:w.generation},expected_commit:'',retain_branch:true,state:'pending',attempts:0,error:null,next_retry_at:null};
 await withQueryableTransaction(db,async tx=>{
  const inserted=await tx.query('UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1 AND NOT(cleanup_json ? $2)',[w.id,key,JSON.stringify(r)]);
  if(inserted.rowCount){await refreshCleanupSummary(tx,w.id);await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:userId,payload:{workspace_id:w.id,resource_key:key,operation_id:r.operation_id}});}
 });
}


/** Each reported ref carries the newest epoch the Host kept it under (this release's when the Host has no keeper record). */
function historyReleases(w:{id:string;generation:number},history:readonly string[],epochs:Readonly<Record<string,number>>,epoch:number):RefRelease[]{
 return history.map(c=>({ref:`refs/rainver/run-history/${w.id}/g${w.generation}/${c}`,expected_commit:c,kept_epoch:epochs[c]??epoch}));
}
/** Waiting for transport/leases does not spend the eight actual-failure attempts. */
function hostFailure(reason:string){
 return workspaceHostFailureIsTemporary(reason)?new JobDeferredError(reason,30000):new Error(reason);
}
