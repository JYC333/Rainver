import {cleanupNativeWorkspaceReceipts} from './workspaceNativeCleanup.js';
import {admitMaterialization,completedRelease,historyKeepers,journaledRefOperation,keepRunHistory,pinSources,recordHistoryKeepers,refOperationDigest,releaseRequestDigest,runHistoryRefs,listRainverRefs,ownedWorkspaceRefs,rebuiltSinceRelease,recordedMaterializationEpoch,recordReleasedMaterialization,reclaimWorkspaceReceipts,releaseRefs,settleRefOperations,verifyBranchReclaim,keepSources,keptSources,releaseSourceKeepers,SourceRefWriteError,legacyReleaseRequestDigest,sameRequest,DIGEST_VERSION,RunHistoryError} from './workspaceRetention.js';
import {syncExistingDurable,writeJsonDurable} from './durableFile.js';
import {RefReadError} from './durableRef.js';
import {commitOfRef} from './mainBranch.js';
import {overlappingLocalChanges} from './taskMerge.js';
import {archiveRuntimeProfileContainer} from './managedWorkspaces.js';
import {readWorkspaceFile} from './workspaceFileRead.js';
import {HostWorkspaceLaunchReportSchema} from '@rainver/protocol';
import {captureSourceBaseline,assertWorkspaceCheckoutAllowed} from './workspaceBaseline.js';
import {acquireLocationLeases,releaseLocationLeases} from './locationLease.js';
import {workspacePathLeaseKeys} from './readOnlyWorkspace.js';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionWorkspaceRef } from '@rainver/protocol';
import { runLocationGit } from '@rainver/folder-read';
import { checkLocationRepository, gitOrThrow, prepareTaskWorktree, settleTaskRun, taskBranchRef, worktreesBase, type LocationRepository, type GitIdentity } from './taskWorktree.js';
import { workspaceWorktreeKey,workspaceRunKey } from './worktreeIdentity.js';

/** Narrow adapter over the single owned-worktree mechanical implementation. */
export async function prepareExecutionWorkspace(repo:LocationRepository,locationId:string,ref:ExecutionWorkspaceRef,runId:string,attempt?:{launchId:string;onQueued:()=>void}){
  const receiptRunId=workspaceRunKey(runId,ref);
  const key=workspaceWorktreeKey(ref),branchRef=taskBranchRef(key);
  // Same identity after a reclaim: an older epoch's launch cannot rebuild it.
  await admitMaterialization(locationId,key,ref);
  const existing=await runLocationGit(['rev-parse','--verify',branchRef],repo.root);
  const prior=await readJson(join(configDir(),'task-runs',`${receiptRunId}.json`));
  const active=await readJson(join(configDir(),'task-records',locationId,`${key}.json`));
  const refresh=ref.sync_to_target&&existing.code===0&&!prior&&!active
    &&(!ref.base_commit||existing.stdout.trim()===ref.base_commit);
  const symbolic=await runLocationGit(['symbolic-ref','--quiet','HEAD'],repo.root);
  const targetRef=ref.target_ref??(symbolic.code===0?symbolic.stdout.trim():null);
  let base=ref.base_commit,baseline={kind:'committed' as 'committed'|'snapshot',head:null as string|null,tree:null as string|null};
  const receipt=join(configDir(),'workspace-baselines',locationId,`${key}.json`);
  if((existing.code!==0&&!base)||refresh){
    const holder=attempt?.launchId??`baseline:${runId}`;
    const ids=[locationId,...workspacePathLeaseKeys(repo.root,[repo.root]),`workspace-git:${repo.gitCommonDir}`];
    const outcome=await acquireLocationLeases(ids,{runId,launchId:holder},attempt?.onQueued??(()=>{}));
    if(outcome!=='acquired')throw new Error('workspace_baseline_cancelled');
    try{
      const status=await gitOrThrow(['status','--porcelain','--untracked-files=all'],repo.root);
      if(status&&!ref.baseline_mode)throw new Error('waiting_for_baseline: source has uncommitted changes; choose committed or snapshot');
      if(status&&ref.baseline_mode==='snapshot'){
        if(targetRef&&symbolic.stdout.trim()!==targetRef)throw new Error('waiting_for_baseline: source branch differs from target');
        const snap=await captureSourceBaseline(repo);base=snap.commit;baseline={kind:'snapshot',head:snap.head,tree:snap.tree};
      }else base=await gitOrThrow(['rev-parse','--verify',`${targetRef??'HEAD'}^{commit}`],repo.root);
      await assertWorkspaceCheckoutAllowed(repo.root,base!);
      if(refresh){
        const old=existing.stdout.trim();
        const physical=await executionWorkspacePath(repo.root,locationId,ref).catch(()=>null);
        if(physical){
          const dirty=await gitOrThrow(['status','--porcelain','--untracked-files=all'],physical);
          const overlaps=await overlappingLocalChanges(physical,old,base!);
          if(dirty||overlaps.length){base=old;}
          else{await gitOrThrow(['update-index','--refresh'],physical);await gitOrThrow(['read-tree','-m','-u',old,base!],physical,10*60*1000);}
        }
        await gitOrThrow(['update-ref',`refs/rainver/recovery/${ref.id}/${old}`,old],repo.root);
        await gitOrThrow(['update-ref','-m','rainver: sync idle workspace',branchRef,base!,old],repo.root);
      }
      await writeJson(receipt,baseline);
    }finally{releaseLocationLeases(ids,holder);}
  }else{
    const stored=await readJson(receipt);
    if(stored?.kind==='snapshot')baseline={kind:'snapshot',head:typeof stored.head==='string'?stored.head:null,tree:typeof stored.tree==='string'?stored.tree:null};
  }
  base??=await gitOrThrow(['rev-parse','--verify',`${branchRef}^{commit}`],repo.root);
  await assertWorkspaceCheckoutAllowed(repo.root,base);
  const prepared=await prepareTaskWorktree(repo,locationId,key,receiptRunId,{baseCommit:base,keepTree:true});
  const counterPath=join(configDir(),'workspace-sequences',locationId,`${key}.json`);
  // The server's floor survives a reclaimed sequence receipt, so a rebuilt
  // workspace never reports a sequence its older checkpoints already used.
  const counter=await readJson(counterPath),sequence=Math.max(Number(counter?.sequence??0),ref.launch_sequence_floor??0)+1;
  if(!Number.isSafeInteger(sequence)||sequence>2147483647)throw new Error('workspace_sequence_exhausted');
  await writeJson(counterPath,{sequence});
  const report={id:ref.id,generation:ref.generation,workspace_location_id:locationId,branch:prepared.branch,start_commit:prepared.startCommit,
    target_ref:targetRef,baseline_kind:baseline.kind,snapshot_head:baseline.head,baseline_tree:baseline.tree,launch_sequence:sequence};
  await writeJson(join(configDir(),'workspace-launches',`${receiptRunId}.json`),report);
  return {...prepared,targetRef,baselineKind:baseline.kind,snapshotHead:baseline.head,baselineTree:baseline.tree,launchSequence:sequence};
}
export async function checkpointExecutionWorkspace(input:{locationRoot:string;locationId:string;workspace:ExecutionWorkspaceRef;runId:string;author:GitIdentity;message:string}){
  // The existing settle captures only this Run, owns its ref update and retains
  // recovery evidence before reclaiming the physical tree. Next Run reconstructs it.
  const key=workspaceWorktreeKey(input.workspace),receiptRunId=workspaceRunKey(input.runId,input.workspace),result=await settleTaskRun({...input,runId:receiptRunId,taskId:key});
  if(result.ok&&result.branch&&!result.commit){
    const receipt=await readJson(join(configDir(),'task-runs',`${receiptRunId}.json`));
    if(receipt?.location_id===input.locationId&&receipt.task_id===key&&typeof receipt.start_commit==='string')return {...result,commit:receipt.start_commit};
  }
  return result;
}
export async function executionWorkspacePath(locationRoot:string,locationId:string,ref:ExecutionWorkspaceRef):Promise<string>{
  const check=await checkLocationRepository(locationRoot);
  if(check.kind!=='repository')throw new Error('execution_workspace_repository_unavailable');
  const base=await worktreesBase(locationId,false);
  if(!base)throw new Error('execution_workspace_missing');
  const root=join(base,workspaceWorktreeKey(ref));
  const info=await lstat(root);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(root)!==root)throw new Error('execution_workspace_invalid');
  return root;
}

import { configDir } from './config.js';
import { readJson, writeJson, deleteTaskBranchHeld, ownedWorkspaceInventory, withTaskHeld, taskLeaseKey, TASK_BUSY } from './taskWorktree.js';
import type { HostServerFrameOf } from '@rainver/protocol';

export async function executeWorkspaceCommand(locationRoot:string|null,frame:HostServerFrameOf<'execution_workspace_command'>){
 const ref=frame.workspace.execution_workspace,key=workspaceWorktreeKey(ref),locationId=frame.workspace.workspace_location_id;
 // Cache identity is Agent × workspace/attempt UUID. Retirement must remain
 // possible after the authorized source Location was removed or unregistered.
 if(frame.action==='archive_profiles'){
  if(!frame.profile_agents?.length)return {ok:false,branch:null,commit:null,error:'workspace_profile_scope_missing'};
  for(const agentId of frame.profile_agents)await archiveRuntimeProfileContainer(agentId,'workspace',ref.integration_id??ref.id);
  return {ok:true,branch:null,commit:null,error:null};
 }

 if(!locationRoot)return {ok:false,branch:null,commit:null,error:'execution_workspace_location_unavailable'};
 const check=await checkLocationRepository(locationRoot);
 if(check.kind!=='repository')return {ok:false,branch:null,commit:null,error:'execution_workspace_repository_unavailable'};
 const branch=taskBranchRef(key).replace('refs/heads/','');
 const current=await runLocationGit(['rev-parse','--verify',taskBranchRef(key)],locationRoot);
 const commit=current.code===0?current.stdout.trim():null;
 if(frame.action==='mirror'){
  if(!ref.integration_id||!frame.expected_commit)return {ok:false,branch,commit,error:'workspace_mirror_identity_required'};
  await assertWorkspaceCheckoutAllowed(locationRoot,frame.expected_commit);
  const w=await prepareTaskWorktree(check.repo,locationId,key,`${ref.integration_id}:verification`,{baseCommit:frame.expected_commit,keepTree:true});
  if(w.startCommit!==frame.expected_commit)return {ok:false,branch,commit,error:'workspace_mirror_checkpoint_moved'};
  return {ok:true,branch:w.branch,commit:w.startCommit,error:null};
 }
 if(frame.action==='read'){
  if(!frame.expected_commit||!frame.path)return {ok:false,branch,commit,error:'workspace_file_input_missing'};
  const file=await readWorkspaceFile(locationRoot,locationId,ref,frame.expected_commit,frame.path);
  return {ok:true,branch,commit,file,error:null};
 }
 if(frame.action==='inspect'){
  const stored=frame.run_id?await readJson(join(configDir(),'workspace-launches',`${workspaceRunKey(frame.run_id,ref)}.json`)):null;
  const launch=HostWorkspaceLaunchReportSchema.safeParse(stored);
  const info=launch.success&&launch.data.id===ref.id&&launch.data.generation===ref.generation&&launch.data.workspace_location_id===locationId?launch.data:null;
  return {ok:true,branch,commit,inventory:await inventoryWithRefs(check.repo,locationId,key,ref,frame.list_after,frame.history_after),...(info?{launch_info:info}:{}),error:null};
 }
 if(frame.action==='list_refs'){
  const listed=await listRainverRefs(locationRoot,frame.list_after);
  return {ok:true,branch,commit,refs:listed.refs,refs_next:listed.next,error:null};
 }
 if(frame.action==='release_refs'){
  // Standalone ref operations (later pages of a release, local preimages and
  // Run history after their retention, re-pinning shared sources). Never
  // touches the workspace branch or tree. Always under this identity's Task
  // lease, so it is ordered against launches and branch releases (which keep
  // Run history), and journaled by operation id: a reply proves the operation
  // finished; a re-delivery after it replays without touching Git.
  const fingerprint=refOperationDigest(frame.release_refs,frame.pin_sources,frame.settle_operations,{keep:frame.keep_sources,release_keepers:frame.release_keepers,source_fence:frame.source_fence},
   {id:ref.id,generation:ref.generation,locationId,integrationId:ref.integration_id??null,...(ref.materialization_epoch!==undefined?{epoch:ref.materialization_epoch}:{})});
  const keeperCommits=[...new Set([...(frame.keep_sources??[]),...(frame.release_keepers??[])])];
  const run=async()=>{
   // One operation under one lease: keep every dependent commit under a ref no
   // earlier operation can name, then settle those operations (none of them can
   // delete anything afterwards), then restore the shared names and only then
   // drop the keepers they replace. No step leaves a commit unreferenced.
   if(frame.keep_sources?.length)await keepSources(locationRoot,ref,frame.keep_sources);
   const settled=frame.settle_operations?.length?await settleRefOperations(frame.settle_operations):undefined;
   const rebuilt=ref.materialization_epoch!==undefined&&await rebuiltSinceRelease(locationId,key,ref.materialization_epoch);
   const pinned=frame.pin_sources?.length?await pinSources(locationRoot,frame.pin_sources):[];
   if(frame.release_keepers?.length)await releaseSourceKeepers(locationRoot,ref,frame.release_keepers);
   const kept=keeperCommits.length?await keptSources(locationRoot,ref,keeperCommits):undefined;
   const retained=await releaseRefs(locationRoot,ref,frame.release_refs??[],{rebuilt,keepers:await historyKeepers(locationId,key),sourceFence:frame.source_fence===true});
   return {retained,pinned,...(settled?{settled}:{}),...(kept?{kept}:{})};
  };
  let held:Awaited<ReturnType<typeof journaledRefOperation>>|null;
  try{held=await withTaskHeld(taskLeaseKey(locationId,key),()=>journaledRefOperation(frame.operation_id,fingerprint,run));}
  catch(error){
   // A keeper or shared name could not be written while its object exists: the
   // journal stays unfinished (no ref_operation in the reply, no settle or
   // deletion ran after it) and the same operation id is re-sent.
   if(error instanceof SourceRefWriteError)return {ok:false,branch,commit,cleanup_state:'retry_wait' as const,error:'workspace_source_ref_write_failed'};
   if(error instanceof RefReadError)return {ok:false,branch,commit,cleanup_state:'retry_wait' as const,error:'workspace_ref_read_failed'};
   throw error;
  }
  if(held===null)return {ok:false,branch,commit,cleanup_state:'retry_wait' as const,error:TASK_BUSY};
  if(held==='conflict')return {ok:false,branch,commit,cleanup_state:'blocked' as const,error:'workspace_ref_operation_conflict'};
  const {retained,pinned,settled,kept}=held.result as {retained:Array<{ref:string;reason:string}>;pinned:string[];settled?:Awaited<ReturnType<typeof settleRefOperations>>;kept?:string[];cancelled?:boolean};
  // A delivery of an operation a later one cancelled: it did nothing.
  if((held.result as {cancelled?:boolean}).cancelled)return {ok:false,branch,commit,cleanup_state:'blocked' as const,error:'workspace_ref_operation_cancelled'};
  const inventory={...await inventoryWithRefs(check.repo,locationId,key,ref),retained_refs:retained,ref_operation:frame.operation_id,...(frame.pin_sources?.length?{pinned_sources:pinned}:{}),...(settled?{settled_operations:settled}:{}),...(keeperCommits.length?{kept_sources:kept??[]}:{})};
  // A truncated prefix family is unfinished, not released: the caller continues it.
  const unfinished=retained.some(r=>r.reason==='ref_release_failed'||r.reason==='ref_release_truncated');
  return {ok:!unfinished,branch,commit,inventory,cleanup_state:unfinished?'retry_wait' as const:'cleaned' as const,error:unfinished?'workspace_refs_incomplete':retained.length?'workspace_refs_retained':null};
 }
 if(frame.action==='checkpoint'){
  if(!frame.run_id||!frame.author)return {ok:false,branch,commit,error:'workspace_checkpoint_input_required'};
  return checkpointExecutionWorkspace({locationRoot,locationId,workspace:ref,runId:frame.run_id,author:frame.author,message:frame.message??'Workspace checkpoint'});
 }
 // Fence, proof, branch/tree removal, ref and receipt release and the
 // completion record form one critical section under the Task lease. A launch
 // prepares (and admits its epoch) under the same lease, so an older cleanup
 // can never interleave with a newer materialization of this identity.
 let held:Awaited<ReturnType<typeof cleanupHeld>>|null;
 try{held=await withTaskHeld(taskLeaseKey(locationId,key),()=>cleanupHeld(check.repo,locationRoot,locationId,key,ref,frame,branch));}
 catch(error){
  // A Run-history version could not be read or kept durably: nothing after it
  // ran (the branch stays), the journal stays running and the release retries.
  if(error instanceof RunHistoryError)return {ok:false,branch,commit,cleanup_state:'retry_wait' as const,error:'workspace_run_history_failed'};
  throw error;
 }
 return held??{ok:false,branch,commit,cleanup_state:'retry_wait' as const,error:TASK_BUSY};
}

async function cleanupHeld(repo:LocationRepository,locationRoot:string,locationId:string,key:string,ref:ExecutionWorkspaceRef,frame:HostServerFrameOf<'execution_workspace_command'>,branch:string){
 const current=await runLocationGit(['rev-parse','--verify',taskBranchRef(key)],locationRoot);
 const commit=current.code===0?current.stdout.trim():null;
 const journal=join(configDir(),'workspace-cleanup',`${frame.operation_id}.json`);
 const epoch=ref.materialization_epoch;
 // The whole request, not only its identity: the same operation or epoch with
 // a different history/ref list/target/proof is a different request.
 const request={id:ref.id,generation:ref.generation,locationId,integrationId:ref.integration_id??null,expected:frame.expected_commit,retain:frame.retain_branch,epoch,target:ref.target_ref??null,
  history:frame.history_commits,proof:frame.reclaim_proof,bases:frame.reclaim_bases,refs:frame.release_refs};
 const digest={current:releaseRequestDigest(request),legacy:legacyReleaseRequestDigest(request)},fingerprint=digest.current,digest_version=DIGEST_VERSION;
 const prior=await readJson(journal);
 // A quarantine refusal had no side effects: the server may turn that same
 // operation into a physical-only request without a conflict. A journal from
 // before digest v2 is recognised by its v1 digest, so a resumed release continues.
 const priorInert=prior?.state==='blocked'&&prior.error==='workspace_quarantined';
 const priorSame=sameRequest(prior,digest);
 if(prior&&!priorSame&&!priorInert)return {ok:false,branch,commit,cleanup_state:'blocked' as const,error:'workspace_cleanup_identity_conflict'};
 // A journal from before v2 accepted here is bound to this request's full v2
 // digest before any answer (replay, refusal or run), so no later delivery of
 // this id that only v1 cannot tell apart (a changed kept_epoch) matches it.
 if(priorSame&&prior!.digest_version!==DIGEST_VERSION)await writeJsonDurable(journal,{...prior,fingerprint,digest_version});
 const releasing=!frame.retain_branch&&!ref.integration_id;
 const failedRefs=(refs:Array<{reason:string}>)=>refs.some(r=>r.reason==='ref_release_failed'||r.reason==='ref_release_truncated');
 // A finished release of exactly this epoch replays its durable result before
 // the epoch fence: its own fence record must never make a crash-retried
 // delivery look like a newer materialization. Any newer launch since then
 // does not change what this release did or owes (history, later pages).
 if(releasing&&epoch!==undefined){
  const done=await completedRelease(locationId,key,ref,epoch,frame.expected_commit??null,digest);
  // Different content under a finished release's identity and epoch is refused,
  // never replayed as done. Once a newer launch rebuilt, the request is simply
  // obsolete and the epoch fence below answers it as moved.
  if(done==='conflict'&&!await rebuiltSinceRelease(locationId,key,epoch))return {ok:false,branch,commit,inventory:await inventoryWithRefs(repo,locationId,key,ref),cleanup_state:'blocked' as const,error:'workspace_release_request_conflict'};
  if(done&&done!=='conflict'){
   await writeJsonDurable(journal,{fingerprint,digest_version,state:'cleaned',retained_refs:done.retained_refs,history_refs:done.history_refs,replayed:true,at:new Date().toISOString()});
   return {ok:true,branch,commit,inventory:{...done.inventory} as Awaited<ReturnType<typeof inventoryWithRefs>>,cleanup_state:'cleaned' as const,error:null};
  }
 }
 if(prior?.state==='cleaned'){
  const inventory=await inventoryWithRefs(repo,locationId,key,ref);
  if((frame.retain_branch||!inventory.branch||prior.branch_retained_reason)&&!inventory.worktree&&!inventory.registration&&!inventory.run_record&&!inventory.merge_record&&inventory.quarantined_whole===0){
   // A legacy record was already rewritten bound to the v2 digest above (itself the barrier).
   if(prior.digest_version===DIGEST_VERSION)await syncExistingDurable(journal);
   return {ok:true,branch,commit,inventory:{...inventory,...(typeof prior.branch_retained_reason==='string'?{branch_retained_reason:prior.branch_retained_reason}:{}),...(Array.isArray(prior.retained_refs)?{retained_refs:prior.retained_refs}:{})},cleanup_state:'cleaned' as const,error:null};
  }
 }
 // The server raises the epoch before it issues a branch release, so every
 // later launch carries a newer one and is admitted (recorded) under this
 // lease. A cleanup for an older epoch (late, replayed or re-delivered) must
 // never remove that materialization, even at the same tip.
 if(epoch!==undefined&&epoch<await recordedMaterializationEpoch(locationId,key))
  return {ok:false,branch,commit,inventory:await inventoryWithRefs(repo,locationId,key,ref),cleanup_state:'blocked' as const,error:'workspace_materialization_moved'};
 // Physical safety precedes every release side effect: beside a whole-tree
 // quarantine (unsaved work) nothing is deleted, no ref, receipt or fence moves.
 if(releasing&&(await ownedWorkspaceInventory(repo,locationId,key)).quarantined_whole>0){
  await writeJsonDurable(journal,{fingerprint,digest_version,state:'blocked',error:'workspace_quarantined',at:new Date().toISOString()});
  return {ok:false,branch,commit,inventory:await inventoryWithRefs(repo,locationId,key,ref),cleanup_state:'blocked' as const,error:'workspace_quarantined'};
 }
 // Crash recovery: until the release finished, the Host's recorded epoch is
 // not past this one, so a re-delivery of the same release (even under a fresh
 // operation id) passes the fence, finds no branch (nothing to prove) and
 // finishes the remaining history, refs, receipts and fence record.
 const strings=(v:unknown)=>Array.isArray(v)?v.filter((c):c is string=>typeof c==='string'):[];
 const historyCandidates=[...new Set([...(frame.history_commits??[]),...(priorSame?[...strings(prior!.history_intent),...strings(prior!.history_refs)]:[])])];
 // Versions whose object Git cleanly reports gone: never kept, recorded and reported as unavailable.
 let unavailable:string[]=priorSame?strings(prior!.history_unavailable):[];
 await writeJsonDurable(journal,{fingerprint,digest_version,state:'running',...(historyCandidates.length?{history_intent:historyCandidates}:{}),...(unavailable.length?{history_unavailable:unavailable}:{}),at:new Date().toISOString()});
 let history:string[]=[];
 // Exact past Run versions the target cannot reach get owned refs before the
 // branch goes. The intent is durable before the first ref is created, and the
 // refs actually present in Git are the list reported back (even after a
 // failure part-way), so every created ref gets its expiry.
 const keepHistory=async(root:string)=>{
  if(!historyCandidates.length)return;
  await writeJsonDurable(journal,{fingerprint,digest_version,state:'running',history_intent:historyCandidates,at:new Date().toISOString()});
  // The renewal is durable before any ref exists: an older expiry of the same
  // commit (a delayed release_refs, also under this lease) is then refused.
  if(epoch!==undefined)await recordHistoryKeepers(locationId,key,historyCandidates,epoch);
  // A read fault throws here, before the branch goes: the journal stays running and the release retries.
  const kept=await keepRunHistory(root,ref,ref.target_ref?await commitOfRef(root,ref.target_ref):null,historyCandidates);
  history=kept.kept;unavailable=[...new Set([...unavailable,...kept.unavailable])];
  await writeJsonDurable(journal,{fingerprint,digest_version,state:'running',history_intent:historyCandidates,history_refs:history,...(unavailable.length?{history_unavailable:unavailable}:{}),at:new Date().toISOString()});
 };
 const result=await deleteTaskBranchHeld({locationRoot,locationId,taskId:key,expectedCommit:frame.expected_commit,retainBranch:frame.retain_branch,
  ...(releasing?{branchRelease:{
   verify:(root:string,tip:string)=>verifyBranchReclaim(root,tip,ref.target_ref,frame.reclaim_proof??[],frame.reclaim_bases??[]),
   beforeRelease:keepHistory,
  }}:{})});
 let retainedRefs:Array<{ref:string;reason:string}>=[];
 // Released: the branch went now, earlier in this epoch, or never existed, and
 // no whole tree was quarantined. A proof refusal, a moved tip, a quarantine or
 // a refused dirty tree (ok:false) releases nothing.
 const settled=await ownedWorkspaceInventory(repo,locationId,key);
 const released=releasing&&result.ok&&!result.branch_retained_reason&&!settled.branch&&settled.quarantined_whole===0;
 if(released){
  // Resumed or branchless release: recover the list from the journal and the
  // owned history refs (or still-present commits) instead of losing it.
  if(!result.tip)await keepHistory(locationRoot);
  // Run-history refs this release just (re)kept are renewed: a listed older expiry of them is refused here too.
  retainedRefs=await releaseRefs(locationRoot,ref,frame.release_refs??[],{keepers:await historyKeepers(locationId,key)});
  if(!failedRefs(retainedRefs))await reclaimWorkspaceReceipts(locationId,key,ref);
 }
 const inventory={...await inventoryWithRefs(repo,locationId,key,ref),...(result.branch_retained_reason?{branch_retained_reason:result.branch_retained_reason}:{}),...(retainedRefs.length?{retained_refs:retainedRefs}:{}),...(unavailable.length?{history_unavailable:unavailable.slice(0,1000)}:{})};
 // What Git holds is the record, whatever this attempt finished.
 history=('history_refs' in inventory?inventory.history_refs:undefined)??[];
 const branchSettled=frame.retain_branch||!inventory.branch||Boolean(result.branch_retained_reason);
 const complete=result.ok&&branchSettled&&!inventory.worktree&&!inventory.registration&&!inventory.run_record&&!inventory.merge_record&&inventory.quarantined_whole===0&&!failedRefs(retainedRefs);
 // The release result and its fence are one atomic record (replayed above).
 if(complete&&released&&epoch!==undefined)await recordReleasedMaterialization(locationId,key,epoch,{id:ref.id,generation:ref.generation,expected_commit:frame.expected_commit??null,request:fingerprint,digest_version,history_refs:history,retained_refs:retainedRefs,inventory});
 if(complete&&!ref.integration_id&&!released)await cleanupNativeWorkspaceReceipts(locationId,key);
 const state=complete?'cleaned':inventory.quarantined_whole>0||['workspace_generation_moved','workspace_uncheckpointed'].includes(result.error??'')?'blocked':'retry_wait';
 await writeJsonDurable(journal,{fingerprint,digest_version,state,...(unavailable.length?{history_unavailable:unavailable}:{}),error:inventory.quarantined_whole>0?'workspace_quarantined':result.error,...(historyCandidates.length?{history_intent:historyCandidates}:{}),...(result.branch_retained_reason?{branch_retained_reason:result.branch_retained_reason}:{}),...(retainedRefs.length?{retained_refs:retainedRefs}:{}),...(history.length?{history_refs:history}:{}),at:new Date().toISOString()});
 return {ok:complete,branch,commit,inventory:complete&&released&&epoch!==undefined?{...inventory,materialization_epoch:await recordedMaterializationEpoch(locationId,key)}:inventory,cleanup_state:state as 'cleaned'|'blocked'|'retry_wait',error:inventory.quarantined_whole>0?'workspace_quarantined':result.error};
}

async function inventoryWithRefs(repo:LocationRepository,locationId:string,key:string,ref:ExecutionWorkspaceRef,after?:string,historyAfter?:string){
 const base=await ownedWorkspaceInventory(repo,locationId,key);
 if(ref.integration_id)return base;
 // One bounded history page with its cursor and keeper epochs; the server
 // continues the pages durably until the cursor is null.
 const history=await runHistoryRefs(repo.root,ref,historyAfter);
 // Reported keeper epochs and the epoch fence decide later expiries and
 // launches on the server: what is reported is made durable first.
 if(history.commits.length)await syncExistingDurable(join(configDir(),'workspace-history-keepers',locationId,`${key}.json`));
 await syncExistingDurable(join(configDir(),'workspace-materializations',locationId,`${key}.json`));
 const keepers=history.commits.length?await historyKeepers(locationId,key):{};
 const epochs=Object.fromEntries(history.commits.filter(c=>keepers[c]!==undefined).map(c=>[c,keepers[c]!]));
 return {...base,...await ownedWorkspaceRefs(repo.root,ref,after),...(history.commits.length?{history_refs:history.commits,history_epochs:epochs}:{}),history_refs_next:history.next,materialization_epoch:await recordedMaterializationEpoch(locationId,key)};
}
