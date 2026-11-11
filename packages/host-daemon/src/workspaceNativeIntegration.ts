import {workspaceDeltaAlreadyApplied} from './appliedWorkspaceDelta.js';
import {assertWorkspaceCheckoutAllowed} from './workspaceBaseline.js';
import {join} from 'node:path';
import {HostDaemonFrameSchema,type HostServerFrameOf,type HostDaemonFrameOf} from '@rainver/protocol';
import {runLocationGit} from '@rainver/folder-read';
import {configDir} from './config.js';
import {captureWorkspaceTree} from './gitDiff.js';
import {executionWorkspacePath} from './executionWorkspace.js';
import {leaseOwnedByRun,isLeaseBusy} from './locationLease.js';
import {workspaceWorktreeKey,workspaceRunKey} from './worktreeIdentity.js';
import {checkLocationRepository,gitOrThrow,isAncestor,readJson,writeJson,writeCommit,taskBranchRef,taskLeaseKey,withTaskHeld,useTaskWorktree,isTaskWorktreeInUse,WORKTREE_TIMEOUT_MS} from './taskWorktree.js';
import {mergeTrees,publishWorkspaceCommit,overlappingLocalChanges} from './taskMerge.js';
import {assertChainUnchanged,assertPublicationTarget,freezePublicationChain,writeMergeCommit,type FrozenChain} from './publicationChain.js';
import {hasUnresolvedMarkers,pickCommit,rebaseCommits,replayCommits,type RebaseStop} from './nativeRebase.js';

type Frame=HostServerFrameOf<'workspace_integration'>;
type NativeReply=Omit<HostDaemonFrameOf<'workspace_integration_result'>,'type'|'request_id'>;
interface Journal {
 source:string;base:string;onto:string;prepared:string;conflicts:string[];merged?:string;no_changes?:boolean;publishing_commit?:string;preparing_tree?:string|null;
 /** Frozen at prepare for fast_forward/merge/rebase publication; absent for squash. */
 chain?:FrozenChain;
 /** A rebase stopped on a conflict: the tip before rewriting, its batch base, the
  * replayed tip and the commits still to replay (the stopped one first). */
 rebase?:{original:string;base:string;replayed:string;pending:string[];conflicts:string[]};
 /** A rebase step moving the worktree from clean `from` to `tree`, branch at `tip`; a restart finishes it. */
 applying?:{from:string;tip:string;tree:string}|null;
}
const active=new Set<string>();
/** Cooperate with the caller's live worktree lease. No subprocess/session/cwd change. */
export async function executeNativeWorkspaceIntegration(locationRoot:string|null,frame:Frame):Promise<NativeReply>{
 const empty={main_branch:frame.target_ref.replace(/^refs\/heads\//,''),onto_commit:null as string|null,candidate_commit:null as string|null,conflicted_files:[] as string[]};
 const fail=(error:string):NativeReply=>({...empty,ok:false,outcome:null,error});
 const ref={id:frame.workspace.execution_workspace.id,generation:frame.workspace.execution_workspace.generation};
 const key=workspaceWorktreeKey(ref),locationId=frame.workspace.workspace_location_id,lease=taskLeaseKey(locationId,key);
 if(!locationRoot||!frame.run_id||!frame.operation_id)return fail('native_integration_identity_required');
 if(frame.action==='native_reconcile'){
  const adopted=await workspaceDeltaAlreadyApplied(locationRoot,frame.base_commit,frame.source_commit,await gitOrThrow(['rev-parse',frame.target_ref],locationRoot));
  return adopted?{...empty,ok:true,outcome:'no_changes',error:null}:fail('integration_not_yet_adopted');
 }
 if(frame.action==='native_inspect'){
  const journal=await readJson(join(configDir(),'workspace-native',locationId,key,`${frame.workspace.execution_workspace.integration_id}.json`)) as unknown as Journal|null;
  const candidate=journal?.merged??journal?.publishing_commit;
  if(!candidate)return fail('native_publication_not_recorded');
  const adopted=await runLocationGit(['merge-base','--is-ancestor',candidate,frame.target_ref],locationRoot);
  return adopted.code===0?{...empty,ok:true,outcome:journal?.no_changes?'no_changes':'merged',candidate_commit:candidate,onto_commit:journal!.onto,error:null}:fail('native_publication_not_adopted');
 }
 if(!leaseOwnedByRun(lease,frame.run_id))return fail('native_integration_run_not_active');
 if(active.has(lease))return fail('task_busy');
 active.add(lease);
 const release=useTaskWorktree(lease);
 try{
  // A second request cannot race preparation/publication. Maintenance and restart
  // also see this short operation; the Agent keeps its original exclusive lease.
  const result=await withTaskHeld<NativeReply>(`native-operation:${lease}`,async()=>{
   const check=await checkLocationRepository(locationRoot);
   if(check.kind!=='repository')return fail('execution_workspace_repository_unavailable');
   const repo=check.repo,root=await executionWorkspacePath(locationRoot,locationId,ref);
   const receipt=await readJson(join(configDir(),'workspace-launches',`${workspaceRunKey(frame.run_id!,ref)}.json`));
   if(receipt?.id!==ref.id||receipt.generation!==ref.generation||receipt.workspace_location_id!==locationId)return fail('execution_workspace_run_mismatch');
   const branch=taskBranchRef(key);
   if(await gitOrThrow(['symbolic-ref','-q','HEAD'],root)!==branch)return fail('native_workspace_branch_changed');
   const treeOf=(commit:string)=>gitOrThrow(['rev-parse',`${commit}^{tree}`],root);
   const strategy=frame.publication_strategy??'squash';
   // A chain is only ever published to a non-Rainver branch (or the parent's for delegated work);
   // squash keeps its existing target handling. Every target is a well-formed existing branch.
   // A frame without a strategy is squash (the wire default); the control plane names rebase explicitly.
   if(frame.action==='native_prepare'||frame.action==='native_publish')await assertPublicationTarget(repo.root,frame.target_ref,Boolean(frame.target_workspace)||strategy==='squash');
   // Uncommitted edits would otherwise become an automatic checkpoint commit inside a published chain.
   const committed=async()=>{const head=await gitOrThrow(['rev-parse','HEAD'],root);return await captureWorkspaceTree(root,WORKTREE_TIMEOUT_MS,head)===await treeOf(head)?head:null;};
   const directory=join(configDir(),'workspace-native',locationId,key);
   const journalPath=join(directory,`${frame.workspace.execution_workspace.integration_id}.json`);
   const answerPath=join(directory,`request-${frame.operation_id}.json`);
   const {request_id:_,...meaning}=frame;
   const fingerprint=JSON.stringify(meaning);
   const prior=await readJson(answerPath);
   if(prior){if(prior.fingerprint!==fingerprint)return fail('native_integration_request_changed');const {type:_,request_id:__,...answer}=HostDaemonFrameSchema.parse({...prior.answer as object,type:'workspace_integration_result',request_id:frame.request_id}) as HostDaemonFrameOf<'workspace_integration_result'>;return answer;}
   let stored=await readJson(journalPath) as unknown as Journal|null;
   const snapshot=async(message:string)=>{
    const head=await gitOrThrow(['rev-parse','HEAD'],root);
    const tree=await captureWorkspaceTree(root,WORKTREE_TIMEOUT_MS,head);
    if(!tree)throw new Error('workspace_capture_failed');
    if(tree===await treeOf(head))return head;
    const commit=await writeCommit(repo.root,tree,head,frame.author,message);
    await gitOrThrow(['update-ref','-m','rainver: live workspace checkpoint',branch,commit,head],repo.root);
    return commit;
   };
   if(stored?.publishing_commit&&!stored.merged&&(await runLocationGit(['merge-base','--is-ancestor',stored.publishing_commit,frame.target_ref],repo.root)).code===0){stored={...stored,merged:stored.publishing_commit};await writeJson(journalPath,stored);}
   if(stored?.preparing_tree){
    const current=await captureWorkspaceTree(root,WORKTREE_TIMEOUT_MS);
    if(current===await treeOf(stored.source)){
     await gitOrThrow(['read-tree',stored.source],root);
     await gitOrThrow(['update-index','--refresh'],root);
     const overlap=await overlappingLocalChanges(root,stored.source,stored.preparing_tree);
     if(overlap.length)return {...fail('native_preparation_preserves_local_files'),conflicted_files:overlap.slice(0,500)};
     await gitOrThrow(['read-tree','-m','-u',stored.source,stored.preparing_tree],root,WORKTREE_TIMEOUT_MS);
    }else if(current!==stored.preparing_tree)return fail('native_preparation_recovery_preserves_newer_edits');
    const prepared=await snapshot(frame.message);
    await gitOrThrow(['read-tree',prepared],root);
    stored={...stored,prepared,preparing_tree:null};await writeJson(journalPath,stored);
   }
   /** Moves the worktree from a clean `from` to `tree` and the branch to `tip`
    * (CAS). Untracked and ignored files stay; an overlapping one is returned. */
   const applyRebase=async(step:{from:string;tip:string;tree:string}):Promise<string[]|null>=>{
    const current=await captureWorkspaceTree(root,WORKTREE_TIMEOUT_MS);
    if(current===await treeOf(step.from)){
     await gitOrThrow(['read-tree',step.from],root);
     await runLocationGit(['update-index','-q','--refresh'],root);
     const overlap=await overlappingLocalChanges(root,step.from,step.tree);
     if(overlap.length)return overlap;
     await gitOrThrow(['read-tree','-m','-u',step.from,step.tree],root,WORKTREE_TIMEOUT_MS);
    }else if(current!==step.tree)throw new Error('native_preparation_recovery_preserves_newer_edits');
    if(await gitOrThrow(['rev-parse','HEAD'],root)!==step.tip)await gitOrThrow(['update-ref','-m','rainver: rebase onto the target',branch,step.tip,step.from],repo.root);
    // Index at the replayed tip: a stopped commit's conflict shows as unstaged edits.
    await gitOrThrow(['read-tree',step.tip],root);
    return null;
   };
   if(stored?.applying){
    const overlap=await applyRebase(stored.applying);
    if(overlap)return {...fail('native_preparation_preserves_local_files'),conflicted_files:overlap.slice(0,500)};
    stored={...stored,applying:null};await writeJson(journalPath,stored);
   }
   const storedStrategy=stored?.chain?.strategy??(stored?.rebase?'rebase':'squash');
   /** Journal the replay result before touching the worktree, then apply it. */
   const finishRebase=async(step:{original:string;base:string;onto:string;from:string;replayed:string;pending:string[];stop:RebaseStop|null}):Promise<NativeReply>=>{
    if(!step.stop&&step.replayed===step.onto){
     // Every change of the batch is already target history.
     await writeJson(journalPath,{source:step.original,base:step.base,onto:step.onto,prepared:step.onto,conflicts:[],merged:step.onto,no_changes:true});
     return {...empty,ok:true,outcome:'no_changes',candidate_commit:step.onto,onto_commit:step.onto,error:null};
    }
    const applying={from:step.from,tip:step.replayed,tree:step.stop?step.stop.tree:await treeOf(step.replayed)};
    // The rebased chain is checked (linear, bounded, ordinary paths) before the branch is rewritten.
    const journal:Journal=step.stop
     ?{source:step.original,base:step.base,onto:step.onto,prepared:step.replayed,conflicts:step.stop.conflicted,rebase:{original:step.original,base:step.base,replayed:step.replayed,pending:step.pending,conflicts:step.stop.conflicted},applying}
     :{source:step.replayed,base:step.onto,onto:step.onto,prepared:step.replayed,conflicts:[],chain:await freezePublicationChain(repo.root,'rebase',step.onto,step.replayed,frame.target_ref),applying};
    await writeJson(journalPath,journal);
    const overlap=await applyRebase(applying);
    if(overlap)return {...fail('native_preparation_preserves_local_files'),conflicted_files:overlap.slice(0,500)};
    stored={...journal,applying:null};await writeJson(journalPath,stored);
    return step.stop?{...empty,ok:true,outcome:'conflict',onto_commit:step.onto,conflicted_files:step.stop.conflicted.slice(0,500),error:null}
     :{...empty,ok:true,outcome:'rebased',candidate_commit:step.replayed,onto_commit:step.onto,error:null};
   };
   /** Replays this batch's own commits onto the target in this worktree, one by
    * one; a conflict stops there for the Agent, and the next prepare continues. */
   const prepareRebase=async():Promise<NativeReply>=>{
    if(stored&&storedStrategy!=='rebase')return fail('native_publication_plan_changed');
    if(stored?.rebase){
     // The Agent resolved the stopped commit in this worktree; its own commits on top count as that resolution.
     const state=stored.rebase,head=await gitOrThrow(['rev-parse','HEAD'],root);
     if(!await isAncestor(repo.root,state.replayed,head))return fail('native_rebase_branch_changed');
     const tree=await captureWorkspaceTree(root,WORKTREE_TIMEOUT_MS,head);
     if(!tree)throw new Error('workspace_capture_failed');
     if(await hasUnresolvedMarkers(root,state.replayed,tree,state.conflicts))return {...empty,ok:true,outcome:'conflict',onto_commit:stored.onto,conflicted_files:state.conflicts.slice(0,500),error:null};
     const resolved=tree===await treeOf(state.replayed)?state.replayed:await pickCommit(repo.root,state.pending[0]!,tree,state.replayed,frame.author);
     if(head!==resolved)await gitOrThrow(['update-ref','-m','rainver: rebase onto the target',branch,resolved,head],repo.root);
     await gitOrThrow(['read-tree',resolved],root);await runLocationGit(['update-index','-q','--refresh'],root);
     const rest=await replayCommits(root,repo.root,state.pending.slice(1),resolved,frame.author);
     return finishRebase({original:state.original,base:state.base,onto:stored.onto,from:resolved,...rest});
    }
    // Uncommitted edits become one commit first; then the batch's own commits are replayed.
    const source=await snapshot(frame.message),onto=await gitOrThrow(['rev-parse',`${frame.target_ref}^{commit}`],repo.root);
    if(stored?.chain&&stored.onto===onto&&source===stored.chain.tip)return {...empty,ok:true,outcome:'rebased',candidate_commit:source,onto_commit:onto,error:null};
    // A rebased chain that is prepared again (target moved, or later commits) replays from where it left the target.
    let base=stored?.chain?.base??frame.base_commit,tip=source;
    // An explicit commit (an Agent-submitted one, or a historical batch's recorded
    // source) is replayed instead of this worktree's own history, which must hold no unsubmitted changes.
    const explicit=frame.submitted_commit&&!stored?frame.submitted_commit:null;
    if(explicit){
     if(frame.submitted_base)base=frame.submitted_base;
     else{
      const parents=(await gitOrThrow(['rev-list','--parents','-n','1',explicit],repo.root)).split(/\s+/);
      if(parents.length!==2)return fail('workspace_commit_requires_single_parent');
      base=parents[1]!;
      if((await runLocationGit(['merge-base','--is-ancestor',base,frame.target_ref],repo.root)).code!==0)return fail('workspace_commit_requires_target_history');
     }
     if(await treeOf(source)!==await treeOf(frame.base_commit))return fail('workspace_commit_requires_empty_change');
     await assertWorkspaceCheckoutAllowed(repo.root,explicit);
     tip=explicit;
    }
    const commits=await rebaseCommits(repo.root,base,tip,onto);
    // Retain the complete pre-rebase history before the branch is rewritten.
    await gitOrThrow(['update-ref',`refs/rainver/native-preimages/${ref.id}/g${ref.generation}/${frame.operation_id}`,source],repo.root);
    await gitOrThrow(['read-tree',source],root);await runLocationGit(['update-index','-q','--refresh'],root);
    const replayed=await replayCommits(root,repo.root,commits,onto,frame.author);
    return finishRebase({original:tip,base,onto,from:source,...replayed});
   };
   let answer:NativeReply;
   if(stored?.merged){
    answer={...empty,ok:true,outcome:stored.no_changes?'no_changes':'merged',candidate_commit:stored.merged,onto_commit:stored.onto,error:null};
   }else if(frame.action==='native_checkpoint'){
    const commit=await snapshot(frame.message);
    answer={...empty,ok:true,outcome:'sealed',candidate_commit:commit,onto_commit:stored?.onto??null,error:null};
   }else if(frame.action==='native_prepare'&&strategy==='rebase'){
    answer=await prepareRebase();
   }else if(frame.action==='native_prepare'&&strategy==='fast_forward'){
    // The chain itself is published: nothing is merged into this worktree, and
    // the chain is frozen again on every prepare (later commits re-freeze it).
    if(frame.submitted_commit)return fail('native_publication_chain_requires_worktree');
    if(stored&&stored.chain?.strategy!=='fast_forward')return fail('native_publication_plan_changed');
    const tip=await committed();
    if(!tip)return fail('native_publication_chain_uncommitted');
    const onto=await gitOrThrow(['rev-parse',`${frame.target_ref}^{commit}`],repo.root);
    if((await runLocationGit(['merge-base','--is-ancestor',tip,onto],repo.root)).code===0){
     // The exact chain is already target history.
     await writeJson(journalPath,{source:tip,base:frame.base_commit,onto,prepared:tip,conflicts:[],merged:onto,no_changes:true});
     const done:NativeReply={...empty,ok:true,outcome:'no_changes',candidate_commit:onto,onto_commit:onto,source_commit:tip,base_commit:frame.base_commit,error:null};
     await writeJson(answerPath,{fingerprint,answer:done});return done;
    }
    if((await runLocationGit(['merge-base','--is-ancestor',onto,tip],repo.root)).code!==0)return fail('native_publication_fast_forward_target_moved');
    const chain=await freezePublicationChain(repo.root,'fast_forward',frame.base_commit,tip,frame.target_ref);
    await writeJson(journalPath,{source:tip,base:frame.base_commit,onto,prepared:tip,conflicts:[],chain});
    answer={...empty,ok:true,outcome:'rebased',candidate_commit:tip,onto_commit:onto,error:null};
   }else if(frame.action==='native_prepare'){
    if(strategy==='merge'&&frame.submitted_commit)return fail('native_publication_chain_requires_worktree');
    if(stored&&storedStrategy!==strategy)return fail('native_publication_plan_changed');
    if(strategy==='merge'&&!stored?.chain&&!await committed())return fail('native_publication_chain_uncommitted');
    const source=await snapshot(frame.message),onto=await gitOrThrow(['rev-parse',`${frame.target_ref}^{commit}`],repo.root);
    // A merge publication keeps the first frozen chain; later prepared/repair
    // commits become the content of the merge commit, never part of the chain.
    const chain=strategy==='merge'?stored?.chain??await freezePublicationChain(repo.root,'merge',frame.base_commit,source,frame.target_ref):undefined;
    if(stored&&onto===stored.onto){
     answer={...empty,ok:true,outcome:stored.conflicts.length?'conflict':'rebased',candidate_commit:source,onto_commit:onto,conflicted_files:stored.conflicts.slice(0,500),error:null};
    }else{
     let base=stored?.onto??frame.base_commit,sourceCommit=source;
     // An explicit commit publishes a recorded delta instead of this worktree's
     // own changes: an Agent-submitted independent commit, or a historical batch
     // whose source is not the worktree. Its recorded base is the delta base;
     // without one, its single parent, which must already be target history.
     const explicit=frame.submitted_commit&&!stored?frame.submitted_commit:null;
     if(explicit){
      if(frame.submitted_base)base=frame.submitted_base;
      else{
       const parents=(await gitOrThrow(['rev-list','--parents','-n','1',explicit],repo.root)).split(/\s+/);
       if(parents.length!==2)return fail('workspace_commit_requires_single_parent');
       base=parents[1]!;
       if((await runLocationGit(['merge-base','--is-ancestor',base,frame.target_ref],repo.root)).code!==0)return fail('workspace_commit_requires_target_history');
      }
      sourceCommit=explicit;
     }
     if(await workspaceDeltaAlreadyApplied(repo.root,base,sourceCommit,onto)){
      await writeJson(journalPath,{source:sourceCommit,base,onto,prepared:source,conflicts:[],merged:onto,no_changes:true,...(chain?{chain}:{})});
      const answer:NativeReply={...empty,ok:true,outcome:'no_changes',candidate_commit:onto,onto_commit:onto,source_commit:sourceCommit,base_commit:base,error:null};
      await writeJson(answerPath,{fingerprint,answer});return answer;
     }
     // The worktree becomes the explicit batch. Unsubmitted changes of its own
     // batch are neither overwritten nor mixed in; they are saved or published first.
     if(explicit){
      if(await treeOf(source)!==await treeOf(frame.base_commit))return fail('workspace_commit_requires_empty_change');
      await assertWorkspaceCheckoutAllowed(repo.root,explicit);
     }
     const synthetic=await writeCommit(repo.root,await treeOf(onto),base,frame.author,'Integration comparison baseline');
     const delta=await writeCommit(repo.root,await treeOf(sourceCommit),base,frame.author,frame.message);
     const merged=await mergeTrees(root,synthetic,delta);
     // Journal intent and retain the complete preimage before modifying this
     // Agent's worktree. Never clean ignored dependencies, caches or build files.
     await gitOrThrow(['update-ref',`refs/rainver/native-preimages/${ref.id}/g${ref.generation}/${frame.operation_id}`,source],repo.root);
     const preparing={source:sourceCommit,base,onto,prepared:source,conflicts:merged.conflicted,preparing_tree:merged.tree,...(chain?{chain}:{})};
     await writeJson(journalPath,preparing);
     await gitOrThrow(['read-tree',source],root);
     await gitOrThrow(['update-index','--refresh'],root);
     const overlap=await overlappingLocalChanges(root,source,merged.tree);
     if(overlap.length)return {...fail('native_preparation_preserves_local_files'),conflicted_files:overlap.slice(0,500)};
     await gitOrThrow(['read-tree','-m','-u',source,merged.tree],root,WORKTREE_TIMEOUT_MS);
     const prepared=await snapshot(frame.message);
     // Keep HEAD/index coherent for native git add/commit and for project checks.
     await gitOrThrow(['read-tree',prepared],root);
     await writeJson(journalPath,{...preparing,prepared,preparing_tree:null});
     answer={...empty,ok:true,outcome:merged.conflicted.length?'conflict':'rebased',candidate_commit:prepared,onto_commit:onto,conflicted_files:merged.conflicted.slice(0,500),error:null};
    }
   }else{
    if(!stored||!frame.verified_commit)return fail('native_verification_version_required');
    if(stored.rebase)return fail('native_rebase_unfinished');
    if(storedStrategy!==strategy)return fail('native_publication_plan_changed');
    // fast_forward and rebase both publish the frozen chain tip itself.
    const tipPublished=stored.chain?.strategy==='fast_forward'||stored.chain?.strategy==='rebase';
    if(stored.chain&&frame.publication_chain_tip!==stored.chain.tip)return fail('native_publication_chain_changed');
    if(tipPublished&&await committed()!==stored.chain!.tip)return fail('native_publication_chain_changed');
    const commit=await snapshot(frame.message);
    if(await treeOf(commit)!==await treeOf(frame.verified_commit))return fail('native_verified_version_changed');
    const integrity=await runLocationGit(['diff','--check',stored.onto,commit,'--'],root);
    if(integrity.code!==0)return fail('native_candidate_has_unresolved_changes');
    if(stored.chain)await assertChainUnchanged(repo.root,stored.chain);
    // squash: one new commit on the target tip. fast_forward: the frozen chain tip
    // itself. merge: an ordinary merge commit of the target tip and that chain.
    const candidate=tipPublished?stored.chain!.tip
     :stored.chain?.strategy==='merge'?await writeMergeCommit(repo.root,await treeOf(commit),stored.onto,stored.chain.tip,frame.author,frame.message)
     :await writeCommit(repo.root,await treeOf(commit),stored.onto,frame.author,frame.message);
    if(tipPublished&&(await runLocationGit(['merge-base','--is-ancestor',stored.onto,candidate],repo.root)).code!==0)return fail('native_publication_fast_forward_target_moved');
    await gitOrThrow(['update-ref',`refs/rainver/sources/${candidate}`,candidate],repo.root);
    await writeJson(journalPath,{...stored,publishing_commit:candidate});
    let targetRoot:string|undefined,targetLease:string|undefined;
    if(frame.target_workspace){
     const targetKey=workspaceWorktreeKey(frame.target_workspace);
     if(frame.target_workspace.integration_id||frame.target_ref!==taskBranchRef(targetKey)||targetKey===key)return fail('native_parent_target_mismatch');
     targetLease=taskLeaseKey(locationId,targetKey);
     if(isLeaseBusy(targetLease)||isTaskWorktreeInUse(targetLease))return fail('task_busy');
     targetRoot=await executionWorkspacePath(locationRoot,locationId,frame.target_workspace);
    }
    const published=await publishWorkspaceCommit(repo,locationId,key,empty.main_branch,stored.onto,candidate,{targetRoot,leaseKey:targetLease,canPublish:()=>leaseOwnedByRun(lease,frame.run_id!)});
    if(published.ok&&published.outcome==='merged')await writeJson(journalPath,{...stored,publishing_commit:candidate,merged:published.merged_commit});
    answer={...empty,...published,candidate_commit:published.merged_commit??candidate,onto_commit:stored.onto,conflicted_files:published.overlapping_files};
   }
   const saved=await readJson(journalPath) as unknown as Journal|null;
   if(saved){answer.source_commit=saved.source;answer.base_commit=saved.base;answer.publication={strategy:saved.chain?.strategy??(saved.rebase?'rebase':'squash'),chain_tip:saved.chain?.tip??null,chain_length:saved.chain?.commits.length??0};}
   await writeJson(answerPath,{fingerprint,answer});
   return answer;
  });
  return result??fail('task_busy');
 }catch(error){return fail(error instanceof Error?error.message:'native_integration_failed');}
 finally{release();active.delete(lease);}
}
