import {closedCheckpointHistorySql} from '../projectFolders/workspaceReleaseState.js';
import {workspaceDiscardDependenciesActive} from '../projectFolders/workspaceDiscardDependencies.js';
import {canPreserveTemporarySource} from './workspacePreservation.js';
import {refreshWorkspaceLifecycle} from './workspaceLifecycle.js';
import {recoverUnlaunchedWorkspaceCheckpoint} from '../projectFolders/workspaceUnlaunchedCheckpoint.js';
import {renewCandidateCleanup} from './workspaceCandidateCleanup.js';
import {recordIdleWorkspaceCapture} from './workspaceIdleCapture.js';
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
import {assessWorkspaceRetention,hasAdoptionPins,reclaimCheckpoint,reclaimTarget,hostReleasesRefs,recordRetention,reclaimProofCommits,reclaimBaseCommits,runHistoryCommits,refReleasePlan,localPreimageReleases,workspaceRetentionSettings,REF_RELEASE_PAGE,type RefRelease} from './workspaceRetention.js';
import {hostJournalsManagedWorkspaceOperations,hostJournalsWorkspaceProfileArchives,nextManagedWorkspaceGeneration} from './managedWorkspaceOperations.js';
import {advanceRefRelease,enqueueRefRelease,sameRelease,type DelayedRefKind,type RefInflight} from './workspaceRefRelease.js';

export interface WorkspaceCleanupResource {
 kind?:'legacy_profiles'|DelayedRefKind;legacy_agent_id?:string;legacy_container_id?:string;
 slot_use_id?:string|null;version:1;operation_id:string;workspace:ExecutionWorkspaceRef;expected_commit:string;
 retain_branch:boolean;state:'pending'|'running'|'retry_wait'|'blocked'|'cleaned';attempts:number;
 error:string|null;next_retry_at:string|null;
 /** Profile archive identity, fixed before the first send; `sent_unfenced`: once sent to a Host that could not fence it. */
 archive_generation?:number;sent_unfenced?:boolean;
 attempt_merge_id?:string;
 profile_agents?:string[];profile_run_ids?:string[];profile_thread_run_ids?:string[];profiles_archived?:boolean;owner_integration_id?:string;lifecycle_linked?:boolean;
 capture?:Pick<HostRequestPayload<'workspace_integration'>,'source_commit'|'base_commit'|'target_ref'|'author'>;
 /** Branch release: the materialization epoch being released; the row was raised past it before sending. */
 preserve_commit?:string;discard_commit?:string;
 reclaim_target_ref?:string|null;
 reclaim_checkpoint?:{workspace_id:string;generation:number;commit:string;base_commit:string};
 cleanup_sent?:boolean;
 /** Frozen wire request: a lost reply replays the identical journal/lease identity. */
 cleanup_request?:HostRequestPayload<'execution_workspace_command'>;
 release_epoch?:number;reclaim_proof?:string[];reclaim_bases?:string[];history_commits?:string[];release_refs?:RefRelease[];
 /** Refs of the proven release beyond the first frame, and the owned-ref cursor
  * after the first Host page (null: no further page). Continued by `ref_pages`. */
 release_rest?:RefRelease[];owned_after?:string|null;retained_count?:number;
 /** `ref_pages`: the visible reason recorded when the last page finishes the release. */
 reason_on_finish?:'merged'|'no_changes'|'discarded';
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
 /** Proof refusals back off independently of transport attempts (max one week). */
 proof_waits?:number;
 /** Last Host history-backed checkpoint proof level this resource has tried. */
 history_proof_level?:number;
 /** `workspace_source_lost_before_fence`: dependent commits whose object was already gone when the settle first reached them. */
 lost_sources?:string[];
}
/** Enqueue immediately by default; only an explicit resource due time delays it. */
export async function enqueueWorkspaceCleanup(db:Queryable,w:ExecutionWorkspaceRow,ref:ExecutionWorkspaceRef,expected:string,retainBranch:boolean,userId:string,ownerIntegrationId?:string,capture?:WorkspaceCleanupResource['capture'],at?:Date|'now',confirmedOperationId?:string){
 return withQueryableTransaction(db,async db=>{
 const key=ref.integration_id??`source-g${ref.generation}`;
 const current=(await db.query<{resource:WorkspaceCleanupResource|null}>('SELECT cleanup_json->$2 AS resource FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id,key])).rows[0]?.resource;
 if(current&&!replaceableSourceCleanup(current)&&current.operation_id!==confirmedOperationId){
  // Never replace an unconfirmed Host effect with a new deletion grant.
  const payload={workspace_id:w.id,resource_key:key,operation_id:current.operation_id};
  if(!(await db.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_cleanup' AND status IN ('pending','claimed','running') AND payload_json @> $1::jsonb",[JSON.stringify(payload)])).rowCount)
   await new PgJobQueueRepository(db).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:userId,payload});
  return;
 }

 if(!ref.integration_id&&!ownerIntegrationId)ownerIntegrationId=(await db.query<{id:string}>("SELECT id FROM task_merges WHERE workspace_id=$1 AND generation=$2 AND status IN ('merged','no_changes') AND detail_json ? 'lifecycle' AND (detail_json->'lifecycle'->>'slot_use_id') IS NOT DISTINCT FROM (SELECT retention_json->>'slot_use_id' FROM execution_workspaces WHERE id=$1) AND (source_commit=$3 OR task_commit=$3 OR merged_commit=$3) ORDER BY completed_at DESC NULLS LAST,id LIMIT 1",[w.id,ref.generation,expected])).rows[0]?.id;
 const resource:WorkspaceCleanupResource={slot_use_id:(w as ExecutionWorkspaceRow&{retention_json?:{slot_use_id?:string}}).retention_json?.slot_use_id??null,version:1,operation_id:randomUUID(),workspace:ref,expected_commit:expected,
  ...(ownerIntegrationId?{owner_integration_id:ownerIntegrationId}:{}),...(capture?{capture}:{}),retain_branch:retainBranch,state:'pending',attempts:0,error:null,next_retry_at:null};
 if(ref.integration_id){
  resource.attempt_merge_id=(await db.query<{id:string}>('SELECT id FROM task_merges WHERE workspace_id=$1 AND attempt_id=$2',[w.id,ref.integration_id])).rows[0]?.id;
  const profiles=(await db.query<{id:string;agent_id:string;inline:boolean}>(`SELECT DISTINCT r.id,r.agent_id,r.id IS NOT DISTINCT FROM m.detail_json->>'reply_owner_run_id' AS inline FROM task_merges m JOIN runs r ON r.space_id=m.space_id AND ((r.id=m.detail_json->>'reply_owner_run_id' AND m.attempt_id=$2) OR (r.id=m.resolution_run_id AND m.attempt_id=$2) OR (r.contract_snapshot_json->>'workspace_integration_id'=m.id AND r.contract_snapshot_json->>'workspace_integration_attempt_id'=$2)) WHERE m.workspace_id=$1 AND r.agent_id IS NOT NULL`,[w.id,ref.integration_id])).rows;
  resource.profile_agents=[...new Set(profiles.map(r=>r.agent_id))];resource.profile_run_ids=profiles.map(r=>r.id);resource.profile_thread_run_ids=profiles.filter(r=>!r.inline).map(r=>r.id);
 }
 // Candidate attempts have separate keys. A source is replaced only before
 // send, after completion, or after this exact operation's confirmed refusal.
 await db.query(`UPDATE execution_workspaces SET cleanup_state='pending',cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true),updated_at=now() WHERE id=$1`,[w.id,key,JSON.stringify(resource)]);
 await refreshCleanupSummary(db,w.id);
 // Publication/checkpoint completion triggers cleanup in the same transaction.
 // Active Runs and new changes are checked when the Job executes.
 const idleAfter=at instanceof Date?at:undefined;
 await new PgJobQueueRepository(db).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:userId,
  payload:{workspace_id:w.id,resource_key:key,operation_id:resource.operation_id},
  scheduled_at:idleAfter?new Date(idleAfter):undefined});
 });
}
/**
 * A source cleanup that may be replaced (and so fenced) by a fresh one: none
 * yet, finished, or still waiting on a timer. A running request or a release
 * already issued (epoch raised) is never replaced; it finishes or is retried.
 */
export function replaceableSourceCleanup(source:WorkspaceCleanupResource|undefined){
 return !source||source.state==='cleaned'||(source.state==='pending'||source.state==='retry_wait')&&source.release_epoch===undefined&&!source.cleanup_sent&&!source.cleanup_request
  // The Host refuses every release side effect beside a whole-tree quarantine,
  // so such a blocked request removed nothing and a fresh one may follow it.
  ||source.state==='blocked'&&source.error==='workspace_quarantined';
}
export async function advanceWorkspaceCleanup(db:Queryable,workspaceId:string,key:string,operationId:string,userId:string,hosts:HostConnectionRegistry=sharedHostConnectionRegistry,workspaceRoot?:string){
 try{return await advanceWorkspaceCleanupAttempt(db,workspaceId,key,operationId,userId,hosts,workspaceRoot);}
 catch(error){
  if(error instanceof JobDeferredError)await withQueryableTransaction(db,async tx=>{
   // Preconditions can defer before a Host attempt starts. Keep their real
   // reason visible; never overwrite a completed or superseded use.
   const updated=await tx.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],
    (cleanup_json->$2)||$4::jsonb,true) WHERE id=$1 AND cleanup_json->$2->>'operation_id'=$3
     AND cleanup_json->$2->>'state' IN ('pending','running','retry_wait') AND NOT (cleanup_json->$2 ? 'kind')
     AND (cleanup_json->$2->'workspace' ? 'integration_id'
      OR cleanup_json->$2->>'slot_use_id' IS NOT DISTINCT FROM retention_json->>'slot_use_id')`,
    [workspaceId,key,operationId,JSON.stringify({state:'retry_wait',error:error.message,next_retry_at:new Date(Date.now()+error.retryAfterMs).toISOString()})]);
   if(updated.rowCount)await refreshCleanupSummary(tx,workspaceId);
  });
  throw error;
 }
}
async function advanceWorkspaceCleanupAttempt(db:Queryable,workspaceId:string,key:string,operationId:string,userId:string,hosts:HostConnectionRegistry,workspaceRoot?:string){

 const w=(await db.query<ExecutionWorkspaceRow & {cleanup_json:Record<string,WorkspaceCleanupResource>;host_owner:string|null;host_kind:string;host_reclaim:number|null;host_preserve:number|null;host_lifecycle:number|null;materialization_epoch:number}>(`SELECT w.*,h.owner_user_id AS host_owner,h.kind AS host_kind,(h.capabilities_json->'execution_workspaces'->>'reclaim')::int AS host_reclaim,(h.capabilities_json->'execution_workspaces'->>'preserve_source')::int AS host_preserve,(h.capabilities_json->'execution_workspaces'->>'lifecycle')::int AS host_lifecycle FROM execution_workspaces w JOIN hosts h ON h.id=w.execution_host_id WHERE w.id=$1`,[workspaceId])).rows[0];
 const r=w?.cleanup_json[key];
 if(!w||!r||r.operation_id!==operationId||r.state==='cleaned')return {skipped:true};
 if(!r.kind&&!r.workspace.integration_id&&(r.slot_use_id??null)!==(w.retention_json?.slot_use_id??null))return {superseded:true};
 if(r.state==='blocked'&&r.attempts>=8)return {blocked:true};
 // A release issued for an older epoch: the newer materialization owns its own cleanup.
 // Its remaining ref pages still finish: the Host keeps what a rebuild may own,
 // and the pages only touch refs owned by that release's closed facts.
 if(r.release_epoch!==undefined&&r.kind!=='ref_pages'&&w.materialization_epoch!==r.release_epoch+1){await save({...r,state:'cleaned',superseded:true,error:null,next_retry_at:null});return {superseded:true};}
 if((w.host_reclaim??0)<6&&await hasAdoptionPins(db,w.id))throw new JobDeferredError('workspace_cleanup_host_upgrade_required',30000);
 if(r.kind==='local_preimages'||r.kind==='run_history'||r.kind==='ref_pages')return advanceRefRelease(db,w,key,r,userId,hosts,workspaceRoot,save);
 if((r.reclaim_checkpoint||await reclaimCheckpoint(db,w))&&(w.host_reclaim??0)<6)throw new JobDeferredError('workspace_cleanup_host_upgrade_required',30000);
 const discardIntent=(w as ExecutionWorkspaceRow & {retention_json?:{discard_intent?:{source_commit?:string;generation?:number}}}).retention_json?.discard_intent;
 const discard=!r.workspace.integration_id&&r.kind!=='legacy_profiles'?(r.discard_commit??(discardIntent?.generation===w.generation?discardIntent.source_commit:undefined)):undefined;
 if(discard&&((w.host_reclaim??0)<5))throw new JobDeferredError('workspace_cleanup_host_upgrade_required',30000);
 if(discard&&discard!==r.expected_commit)throw new JobDeferredError('workspace_discard_tip_changed',30000);
 let releasing=false,preserving=false;
 if(r.owner_integration_id&&(await db.query("SELECT 1 FROM task_merges WHERE id=$1 AND status IN ('queued','rebasing','resolving','verifying','waiting_local_changes')",[r.owner_integration_id])).rowCount)throw new JobDeferredError('workspace_verification_mirror_in_use',30000);

 // The current primary conversation is a reusable working directory. Retiring
 // older generations and explicit reviewed discard retain their existing path.
 if(!r.workspace.integration_id&&r.kind!=='legacy_profiles'&&!discard&&r.release_epoch===undefined&&!r.cleanup_sent&&w.owner_kind==='conversation'&&!w.parent_workspace_id&&w.state==='ready'){
  const current=(await db.query(`SELECT 1 FROM execution_workspaces n WHERE n.id<>$1 AND n.space_id=$2 AND n.session_id=$3
   AND n.workspace_location_id=$4 AND n.owner_kind='conversation' AND n.generation>$5 LIMIT 1`,[w.id,w.space_id,w.session_id,w.workspace_location_id,w.generation])).rowCount;
  const managed=(await db.query("SELECT 1 FROM task_merges WHERE workspace_id=$1 AND generation=$2 AND detail_json ? 'lifecycle' LIMIT 1",[w.id,w.generation])).rowCount;
  if(!current&&managed){
   await recordRetention(db,w.id,{state:'retained',reason:'primary_conversation'});
   await save({...r,state:'cleaned',error:null,next_retry_at:null});return {cleanup_state:'cleaned',source_retained:true};
  }
 }
 if(!r.workspace.integration_id&&r.owner_integration_id&&!r.cleanup_sent&&w.host_lifecycle!==1){
  await db.query("UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1 AND cleanup_json->$2->>'operation_id'=$4",[w.id,key,JSON.stringify({...r,state:'blocked',error:'workspace_lifecycle_host_upgrade_required',next_retry_at:null}),operationId]);
  await refreshCleanupSummary(db,w.id);return {cleanup_state:'blocked'};
 }
 const inUse=(await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id
   WHERE b.workspace_id=$1 AND r.status IN ('running','queued','cancelling') LIMIT 1`,[w.id])).rowCount;
 if(!r.workspace.integration_id&&r.kind!=='legacy_profiles'&&inUse)throw new JobDeferredError('workspace_cleanup_run_active',30000);
 if(!r.workspace.integration_id&&r.kind!=='legacy_profiles'){
  if(r.workspace.id!==w.id||r.workspace.generation!==w.generation)return {skipped:true};
  // The command only froze intent. Host I/O and unchanged-tree proof happen
  // here, outside Operation Core's transaction, before any physical cleanup.
  if((await db.query(`SELECT 1 FROM workspace_change_sets WHERE workspace_id=$1 AND state IN ('abandoned','integrated','no_changes')
   AND verification_json ? 'closure_review' AND source_commit=$2 LIMIT 1`,[w.id,w.head_commit])).rowCount){
   const pending=(await db.query<{run_id:string}>("SELECT run_id FROM execution_workspace_runs WHERE workspace_id=$1 AND checkpoint_state='pending' AND start_commit IS NULL AND launch_sequence=0",[w.id])).rows;
   for(const binding of pending)await recoverUnlaunchedWorkspaceCheckpoint(db,binding.run_id,w.id,w.space_id,hosts,workspaceRoot);
  }
  const unsettled=(await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs run ON run.id=b.run_id
   JOIN workspace_change_sets c ON c.id=b.change_set_id WHERE b.workspace_id=$1 AND
   (run.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review') OR
    (b.checkpoint_state<>'saved' AND ($2::boolean OR NOT(b.checkpoint_state='blocked' AND c.state='abandoned')))) LIMIT 1`,[w.id,Boolean(discard)])).rowCount;
  if(unsettled)throw new JobDeferredError('workspace_cleanup_checkpoint_owed',30000);
  if(discard&&await workspaceDiscardDependenciesActive(db,w.id,'',false))throw new JobDeferredError('workspace_discard_dependencies_active',30000);
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
  if(assessment.reason==='dependent_cleanup'&&r.owner_integration_id)throw new JobDeferredError('workspace_cleanup_dependent_cleanup',30000);
  // Waiting for the grace or a person's hold is not a failed request.
  if(assessment.state==='grace'||assessment.state==='held')throw new JobDeferredError(`workspace_cleanup_${assessment.state}`,Math.max(1000,(Date.parse(assessment.reclaim_after??'')-Date.now())||30000));
  preserving=assessment.state==='retained'&&await canPreserveTemporarySource(db,w.id,r.expected_commit);
  if(preserving&&w.host_preserve!==1){
   const blocked={...r,state:'blocked',error:'workspace_preservation_host_upgrade_required',next_retry_at:null};
   await db.query("UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1 AND cleanup_json->$2->>'operation_id'=$4",[w.id,key,JSON.stringify(blocked),operationId]);
   await recordRetention(db,w.id,{state:'blocked',reason:'host_upgrade_required'});await refreshCleanupSummary(db,w.id);return {cleanup_state:'blocked'};
  }
  releasing=preserving||assessment.state==='reclaimable'&&hostReleasesRefs(w.host_reclaim);
    if(assessment.state==='reclaimable'&&!releasing)await recordRetention(db,w.id,{state:'retained',reason:'host_upgrade_required'});
  if(!releasing&&w.owner_kind==='conversation'){
   // Retained work keeps its branch; only its physical tree follows the idle rule.
   const activity=(await db.query<{wait_ms:number}>(`SELECT GREATEST(0,EXTRACT(EPOCH FROM (GREATEST(MAX(COALESCE(run.ended_at,run.created_at)),(SELECT (retention_json->>'content_changed_at')::timestamptz FROM execution_workspaces WHERE id=$1))+interval '24 hours'-now()))*1000)::float8 AS wait_ms
    FROM execution_workspace_runs b JOIN runs run ON run.id=b.run_id WHERE b.workspace_id=$1`,[w.id])).rows[0];
   if(activity?.wait_ms>0)throw new JobDeferredError('workspace_cleanup_idle_period',Math.ceil(activity.wait_ms));
  }
  }
 }
 const next={...r,state:'running' as const,attempts:r.attempts+1};
 await save(next);
 // A profile archive is one Host operation for every attempt of this resource (identity and generation saved
 // before its first send); sent to a Host that cannot fence it, the launch barrier stays closed on its profile.
 const fixProfileArchiveIdentity=async(resource:WorkspaceCleanupResource,journaled:boolean)=>{
  if(!journaled){if(!resource.sent_unfenced){resource.sent_unfenced=true;await save(resource);}return null;}
  if(!resource.archive_generation){resource.archive_generation=await nextManagedWorkspaceGeneration(db);await save(resource);}
  return {operation_id:`cleanup:${resource.operation_id}`,generation:resource.archive_generation};
 };
 let reply:import('./connectionRegistry.js').TaskBranchReply<'execution_workspace_command'>;
 try{
  if(w.host_kind==='remote'&&w.host_owner!==userId)throw new Error('workspace_cleanup_host_authority_changed');
  await assertProjectWriterForMutation(db,w.space_id,w.project_id,userId);
  if(r.kind==='legacy_profiles'){
   if(!r.legacy_agent_id||!r.legacy_container_id)throw new Error('workspace_legacy_profile_identity_missing');
   const journaled=await hostJournalsManagedWorkspaceOperations(db,w.execution_host_id);
   const identity=await fixProfileArchiveIdentity(next,journaled);
   const answer=await hosts.requestManagedWorkspaceAction(w.execution_host_id,'managed_workspace_archive',{agent_id:r.legacy_agent_id,container_kind:'conversation',container_id:r.legacy_container_id,include_workspace:false,...(identity?{operation_id:identity.operation_id,generation:identity.generation}:{})});
   // A newer operation on that profile was applied first: this archive is superseded, nothing left to move.
   if(!answer.ok&&answer.error_code!=='stale_generation')throw hostFailure(answer.error??'workspace_legacy_profile_archive_failed');
   await save({...next,state:'cleaned',error:null,next_retry_at:null});return {cleanup_state:'cleaned'};
  }
  if(r.profile_agents?.length&&!r.profiles_archived){
   const active=(await db.query(`SELECT 1 FROM runs run WHERE run.space_id=$3 AND (run.id=ANY($4::varchar[]) OR EXISTS(SELECT 1 FROM task_merges m WHERE m.workspace_id=$1 AND m.attempt_id=$2 AND m.resolution_run_id=run.id)) AND run.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review')`,[w.id,r.workspace.integration_id,w.space_id,r.profile_run_ids??[]])).rowCount;
   if(active)throw new JobDeferredError('workspace_profile_run_active',30000);
   const identity=await fixProfileArchiveIdentity(next,await hostJournalsWorkspaceProfileArchives(db,w.execution_host_id));
   const archived=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:await workspaceProfileFrame(db,w,r.workspace,userId),action:'archive_profiles',operation_id:r.operation_id,profile_agents:r.profile_agents,retain_branch:true,...(identity?{archive_identity:identity}:{})});
   if(!archived.ok&&archived.error_code!=='stale_generation')throw hostFailure(archived.error??'workspace_profiles_archive_failed');
   next.profiles_archived=true;
   await db.query(`UPDATE host_threads SET status='closed',vendor_session_id=NULL,vendor_session_launch_id=NULL,pending_archive_at=NULL,updated_at=now() WHERE execution_host_id=$3 AND id IN (SELECT run.host_task_thread_id FROM runs run WHERE run.space_id=$4 AND (run.id=ANY($5::varchar[]) OR EXISTS(SELECT 1 FROM task_merges m WHERE m.workspace_id=$1 AND m.attempt_id=$2 AND m.resolution_run_id=run.id)))`,[w.id,r.workspace.integration_id,w.execution_host_id,w.space_id,r.profile_thread_run_ids??r.profile_run_ids??[]]);
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
  if(!r.workspace.integration_id&&!next.cleanup_request&&!next.cleanup_sent){
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
    if(discard)throw new Error('workspace_quarantined');
    releasing=false;await recordRetention(db,w.id,{state:'retained',reason:'quarantined'});
    // An issued release whose branch is still there becomes physical-only: its
    // raised epoch is harmless (later launches carry a newer one).
    if(next.release_epoch!==undefined){
     for(const field of ['release_epoch','release_id','reclaim_target_ref','reclaim_checkpoint','reclaim_proof','reclaim_bases','history_commits','release_refs','release_rest','owned_after','retained_count'] as const)delete next[field];
     next.retain_branch=true;await save(next);
    }
   }
   if(!resuming&&!absent&&(releasing||!r.cleanup_sent)&&observed.commit!==next.expected_commit){
    if(discard)throw new Error('workspace_discard_tip_changed');
    if(w.head_commit)await recordIdleWorkspaceCapture(db,w,key,r.operation_id,w.head_commit,observed.commit!,'observed');
    await withQueryableTransaction(db,async tx=>{
     const current=(await tx.query<{cleanup_json:Record<string,WorkspaceCleanupResource>;generation:number}>('SELECT cleanup_json,generation FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
     if(current?.generation===r.workspace.generation&&current.cleanup_json[key]?.operation_id===operationId)
      await enqueueWorkspaceCleanup(tx,w,r.workspace,observed.commit!,r.retain_branch,userId,undefined,undefined,undefined,r.operation_id);
    });
    return {superseded:true};
   }
   if(releasing&&next.release_epoch===undefined){
    // Re-assess under the row lock and raise the epoch before sending: a launch
    // admitted from now on carries the newer epoch, so this request can never
    // remove that rebuilt materialization, even at the same tip.
    const plan=await refReleasePlan(db,w,observed.inventory!.owned_refs??[]);
    const checkpoint=await reclaimCheckpoint(db,w),target=await reclaimTarget(db,w);
    const proof=await reclaimProofCommits(db,w.id,w.generation),bases=await reclaimBaseCommits(db,w.id,w.generation),history=await runHistoryCommits(db,w.id,w.generation);
    if(discard)history.splice(0,history.length,...[...new Set([discard,...bases,...history,...plan.release.filter(x=>x.ref.startsWith(`refs/rainver/recovery/${w.id}/`)).map(x=>x.expected_commit!).filter(Boolean)])].slice(0,1000));
    const releaseId=randomUUID();
    const raised=await withQueryableTransaction(db,async tx=>{
     const row=(await tx.query<{materialization_epoch:number;cleanup_json:Record<string,WorkspaceCleanupResource>;generation:number;head_commit:string|null;state:string}>('SELECT materialization_epoch,cleanup_json,generation,head_commit,state FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
     if(!row||row.generation!==r.workspace.generation||row.cleanup_json[key]?.operation_id!==operationId)return null;
     if(row.cleanup_json[key]?.release_epoch!==undefined||row.materialization_epoch!==w.materialization_epoch)return null;
     if(row.state==='blocked'||row.head_commit!==w.head_commit||await workspaceDiscardDependenciesActive(tx,w.id,'',false))return null;
     if(preserving?!await canPreserveTemporarySource(tx,w.id,next.expected_commit):(await assessWorkspaceRetention(tx,w.id)).state!=='reclaimable')return null;
     if(JSON.stringify(await reclaimCheckpoint(tx,w))!==JSON.stringify(checkpoint)||await reclaimTarget(tx,w)!==target)return null;
     await tx.query('UPDATE execution_workspaces SET materialization_epoch=materialization_epoch+1 WHERE id=$1',[w.id]);
     // The release's identity: a page run or reply of another release never finishes this one.
     await recordRetention(tx,w.id,{state:'reclaiming',reason:'reclaiming',retained_refs:plan.retained,release_epoch:row.materialization_epoch,release_id:releaseId});
     const frozen={...next,...(preserving?{preserve_commit:next.expected_commit}:{}),...(discard?{discard_commit:discard}:{}),retain_branch:false,reclaim_target_ref:target,...(checkpoint&&!preserving?{reclaim_checkpoint:checkpoint}:{}),release_epoch:row.materialization_epoch,release_id:releaseId,reclaim_proof:proof,reclaim_bases:bases,history_commits:history,
     // Shared sources go only as re-checked pages, never from this snapshot.
     release_refs:preserving?[]:plan.release.slice(0,REF_RELEASE_PAGE),release_rest:preserving?[]:[...plan.release.slice(REF_RELEASE_PAGE),...plan.sources],owned_after:preserving?null:observed.inventory!.owned_refs_next??null,retained_count:plan.shared_retained};
     await tx.query('UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1',[w.id,key,JSON.stringify(frozen)]);
     await refreshCleanupSummary(tx,w.id);
     return {epoch:row.materialization_epoch,resource:frozen};
    });
    if(raised===null)throw new JobDeferredError('workspace_cleanup_state_changed',30000);
    Object.assign(next,raised.resource);
    w.materialization_epoch=raised.epoch+1;
   }
  }

  // Freeze physical-only authority before its first send as well. Retried
  // operations must never acquire the epoch of a later rebuild.
  if(!next.cleanup_sent&&next.release_epoch===undefined&&next.workspace.materialization_epoch===undefined){
   next.workspace={...next.workspace,materialization_epoch:w.materialization_epoch};await save(next);
  }
  const sendRef=next.release_epoch!==undefined?{...r.workspace,...((next.reclaim_target_ref??w.target_ref)?{target_ref:(next.reclaim_target_ref??w.target_ref)!}:{}),materialization_epoch:next.release_epoch}:next.workspace;
  // A timeout never consumes attempts, so attempts cannot tell an unsent
  // cleanup from a capture whose reply was lost. Persist that distinction.
  if(!next.cleanup_sent&&next.owner_integration_id)next.lifecycle_linked=true;
  next.cleanup_request??={
    workspace:{...frame,execution_workspace:sendRef},action:'cleanup',operation_id:r.operation_id,...(next.lifecycle_linked?{lifecycle_operation_id:next.owner_integration_id}:{}),expected_commit:next.expected_commit,retain_branch:next.retain_branch,
    ...(next.preserve_commit?{preserve_commit:next.preserve_commit}:{}),
    ...(next.discard_commit?{discard_commit:next.discard_commit}:{}),
    ...(next.reclaim_checkpoint?{reclaim_checkpoint:next.reclaim_checkpoint}:{}),
    ...(next.release_epoch!==undefined?{reclaim_proof:next.reclaim_proof??[],reclaim_bases:next.reclaim_bases??[],history_commits:next.history_commits??[],release_refs:next.release_refs??[]}:{})};
  next.cleanup_sent=true;await save(next);
  reply=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',next.cleanup_request);
  if(next.lifecycle_linked&&reply.ok&&reply.lifecycle_operation_id!==next.owner_integration_id)reply={...reply,ok:false,cleanup_state:'blocked',error:'workspace_lifecycle_host_upgrade_required'};
  if(reply.inventory)await db.query(`UPDATE execution_workspaces SET inventory_json=$2::jsonb WHERE id=$1 AND cleanup_json->$3->>'operation_id'=$4 AND ($5::boolean OR (retention_json->>'slot_use_id') IS NOT DISTINCT FROM $6::text) AND generation=$7 AND materialization_epoch=$8`,[w.id,JSON.stringify(reply.inventory),key,operationId,Boolean(r.kind||r.workspace.integration_id),r.slot_use_id??null,w.generation,w.materialization_epoch]);
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
 if(!reply.ok&&reply.error==='workspace_uncheckpointed'&&next.release_epoch!==undefined){
  await withQueryableTransaction(db,async tx=>{
   const current=(await tx.query<{cleanup_json:Record<string,WorkspaceCleanupResource>;generation:number;materialization_epoch:number}>('SELECT cleanup_json,generation,materialization_epoch FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   if(!current||current.generation!==w.generation||current.materialization_epoch!==next.release_epoch!+1||current.cleanup_json[key]?.operation_id!==operationId)return;
   await recordRetention(tx,w.id,{state:'retained',reason:'uncheckpointed_content',proof_refused_tip:next.expected_commit,proof_refused_reason:'uncheckpointed_content',proof_refused_at:new Date().toISOString()});
   await enqueueWorkspaceCleanup(tx,w,r.workspace,next.expected_commit,true,userId,undefined,undefined,undefined,r.operation_id);
  });
  return {superseded:true};
 }
 if(!reply.ok&&reply.error==='workspace_content_captured'&&reply.commit&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(reply.commit)){
  const recorded=await recordIdleWorkspaceCapture(db,w,key,r.operation_id,next.expected_commit,reply.commit);
  if(!recorded)throw new JobDeferredError('workspace_cleanup_capture_unacknowledged',30000);
  // The next round needs a new id. A crash after acknowledgement replays
  // only that operation's recorded capture, without renewing its content clock.
  await withQueryableTransaction(db,async tx=>{
   const current=(await tx.query<ExecutionWorkspaceRow&{cleanup_json:Record<string,WorkspaceCleanupResource>}>('SELECT * FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   if(current?.head_commit===reply.commit&&current.cleanup_json[key]?.operation_id===operationId)
    await enqueueWorkspaceCleanup(tx,current,r.workspace,reply.commit!,true,userId,undefined,undefined,current.owner_kind==='delegation'?'now':new Date(Date.parse(String((current as any).retention_json.content_changed_at))+24*60*60_000),r.operation_id);
  });
  throw new JobDeferredError('workspace_cleanup_content_changed',w.owner_kind==='delegation'?1000:24*60*60_000);
 }
 // Expiry is a refusal, never completion evidence. Renew only the exact
 // still-current physical request; the fresh Job repeats all guards.
 if(!reply.ok&&reply.error==='workspace_cleanup_expired'&&next.release_epoch===undefined){
  return withQueryableTransaction(db,async tx=>{
   const current=(await tx.query<ExecutionWorkspaceRow & {materialization_epoch:number;cleanup_json:Record<string,WorkspaceCleanupResource>}>('SELECT * FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   if(!current||current.cleanup_json[key]?.operation_id!==operationId)return {skipped:true};
   if(current.generation!==r.workspace.generation||current.materialization_epoch!==(r.workspace.materialization_epoch??0)||!r.workspace.integration_id&&current.head_commit!==r.expected_commit){
    await tx.query('UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1',[w.id,key,JSON.stringify({...next,state:'blocked',attempts:r.attempts,error:'workspace_cleanup_expired_recheck_required',next_retry_at:null})]);
    await refreshCleanupSummary(tx,w.id);return {blocked:true};
   }
   const renewed={...next,workspace:{...next.workspace,materialization_epoch:current.materialization_epoch},operation_id:randomUUID(),cleanup_sent:false,state:'pending' as const,attempts:r.attempts,error:null,next_retry_at:null};
   delete renewed.cleanup_request;
   await tx.query('UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1',[w.id,key,JSON.stringify(renewed)]);
   await refreshCleanupSummary(tx,w.id);
   await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:userId,payload:{workspace_id:w.id,resource_key:key,operation_id:renewed.operation_id}});
   return {renewed:true};
  });
 }
 if(!reply.ok&&reply.error?.startsWith('workspace_ignored_quota')){
  await save({...next,state:'blocked',attempts:r.attempts,error:reply.error,next_retry_at:new Date(Date.now()+60_000).toISOString()});
  return {blocked:true};
 }
 // A durable quota page is progress, not a transport/proof failure. Large
 // directories must not exhaust the eight-attempt cleanup budget mid-scan.
 if(!reply.ok&&reply.error==='workspace_ignored_scan_pending')await defer(new JobDeferredError(reply.error,1000));
 if(!reply.ok&&workspaceHostFailureIsTemporary(reply.error))await defer(new JobDeferredError(reply.error!,30000));
 if(!reply.ok&&reply.error==='workspace_source_materialization_moved'&&r.workspace.integration_id){
  try{return await renewCandidateCleanup(db,w,key,r,next,userId);}
  catch(error){if(error instanceof JobDeferredError)await defer(error);throw error;}
 }
 if(!reply.ok&&reply.error==='workspace_materialization_moved'){
  // Older Hosts used this code for source movement too. Only a strictly newer
  // candidate-owned fence proves supersession; absent/ambiguous evidence waits.
  if(r.workspace.integration_id&&!(typeof reply.inventory?.materialization_epoch==='number'&&reply.inventory.materialization_epoch>(r.workspace.materialization_epoch??0)))
   await defer(new JobDeferredError('workspace_candidate_materialization_unproven',30000));
  // The Host admitted a newer materialization first; this request is obsolete.
  await save({...next,state:'cleaned',superseded:true,error:null,next_retry_at:null});
  return {superseded:true};
 }
 const branchRetained=reply.inventory?.branch_retained_reason;
 const proven=reply.inventory&&(next.retain_branch||!reply.inventory.branch||!next.discard_commit&&Boolean(branchRetained))&&!reply.inventory.worktree&&!reply.inventory.registration&&!reply.inventory.run_record&&!reply.inventory.merge_record&&reply.inventory.quarantined_whole===0;

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
  if(next.preserve_commit){
   if(currentRelease)await recordRetention(tx,w.id,{state:'retained',reason:'unpublished_changes',preserved_commit:next.preserve_commit,recovery_ref:`refs/rainver/recovery/${w.id}/${next.preserve_commit}`});
   await refreshCleanupSummary(tx,w.id);return;
  }
  const merged=Boolean((await tx.query("SELECT 1 FROM task_merges WHERE workspace_id=$1 AND status='merged' LIMIT 1",[w.id])).rowCount);
  const pins=(reply.inventory?.retained_refs??[]).filter(x=>x.reason.startsWith('checkpoint_not_in_'))
   .map(x=>next.release_refs?.find(r=>r.ref===x.ref)).filter((x):x is RefRelease=>Boolean(x));
  // A retained checkpoint remains owned by an existing ref Job, with its exact
  // target/publication evidence; it cannot disappear into an aggregate count.
  if(pins.length)next.release_rest=[...(next.release_rest??[]),...pins];
  const more=Boolean(next.release_rest?.length)||typeof next.owned_after==='string';
  const history=reply.inventory?.history_refs??[];
  const facts={retained_refs:kept,reclaim_requested_at:null,history_refs:history.length,history_until:(history.length||historyNext)&&historyUntil?historyUntil.toISOString():null};
  if(currentRelease)await recordRetention(tx,w.id,more?{state:'reclaiming',reason:'releasing_refs',...facts}:{state:'reclaimed',reason:next.discard_commit?'discarded':merged?'merged':'no_changes',...facts,reclaimed_at:new Date().toISOString()});
  else await recordRetention(tx,w.id,{retained_refs:kept,history_refs:history.length,history_until:facts.history_until});
  // The rest of the release continues now, page by page, from the owned-ref cursor.
  // Its pages carry this release's epoch: the Host keeps owned-by-name refs a rebuild may own.
  if(more)await enqueueRefRelease(tx,w,'ref_pages',next.release_rest??[],userId,new Date(),{owned_after:next.owned_after??null,retained_count:kept,workspace:{...r.workspace,...(next.reclaim_target_ref?{target_ref:next.reclaim_target_ref}:{})},reclaim_proof:next.reclaim_proof,reclaim_bases:next.reclaim_bases,release_epoch:next.release_epoch!,...(next.release_id?{release_id:next.release_id}:{}),reason_on_finish:next.discard_commit?'discarded':merged?'merged':'no_changes'});
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
  try{await save({...next,state:'retry_wait',attempts:r.attempts,error:error.message,next_retry_at:new Date(Date.now()+error.retryAfterMs).toISOString()});}
  catch(stale){if(!(stale instanceof JobDeferredError)||stale.message!=='workspace_cleanup_superseded')throw stale;}
  throw error;
 }
 async function save(resource:WorkspaceCleanupResource,also?:(tx:Queryable)=>Promise<void>){
  await withQueryableTransaction(db,async tx=>{
   const saved=await tx.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true),updated_at=now()
    WHERE id=$1 AND cleanup_json->$2->>'operation_id'=$4 AND cleanup_json->$2->>'state'<>'cleaned'
     AND (cleanup_json->$2->>'release_epoch' IS NULL OR cleanup_json->$2->>'release_epoch'=$7::text)
     AND (cleanup_json->$2->'cleanup_request' IS NULL OR cleanup_json->$2->'cleanup_request'=$8::jsonb)
     AND ($5::boolean OR (retention_json->>'slot_use_id') IS NOT DISTINCT FROM $6::text)`,[workspaceId,key,JSON.stringify(resource),operationId,Boolean(r.kind||r.workspace.integration_id),r.slot_use_id??null,resource.release_epoch??null,JSON.stringify(resource.cleanup_request??null)]);
   if(!saved.rowCount)throw new JobDeferredError('workspace_cleanup_superseded',30000);
   if(saved.rowCount&&also)await also(tx);
   if(saved.rowCount)await refreshCleanupSummary(tx,workspaceId);
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
   await db.query(`UPDATE execution_workspaces w SET cleanup_state=CASE
     WHEN (inventory_json ? 'checkpoint_reconciliation_failed_at' OR inventory_json->>'reconciliation_error'='workspace_checkpoint_blocked') AND NOT COALESCE(${closedCheckpointHistorySql('w')},false) THEN 'blocked'
     WHEN EXISTS(SELECT 1 FROM jsonb_each(cleanup_json) r WHERE r.value->>'state'='blocked') THEN 'blocked'
     WHEN COALESCE((inventory_json->>'quarantined_whole')::int,0)>0 THEN 'blocked'
     WHEN EXISTS(SELECT 1 FROM jsonb_each(cleanup_json) r WHERE r.value->>'state'='retry_wait') THEN 'retry_wait'
     WHEN NOT EXISTS(SELECT 1 FROM jsonb_each(cleanup_json) r WHERE r.value->>'state'<>'cleaned' AND NOT(COALESCE(r.value->>'kind','') IN ('local_preimages','run_history') AND r.value->>'state'='pending')) THEN 'cleaned'
     ELSE 'pending' END WHERE id=$1`,[workspaceId]);
   await refreshWorkspaceLifecycle(db,workspaceId);
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
