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
import {checkLocationRepository,gitOrThrow,readJson,writeJson,writeCommit,taskBranchRef,taskLeaseKey,withTaskHeld,useTaskWorktree,isTaskWorktreeInUse,WORKTREE_TIMEOUT_MS} from './taskWorktree.js';
import {mergeTrees,publishWorkspaceCommit,overlappingLocalChanges} from './taskMerge.js';

type Frame=HostServerFrameOf<'workspace_integration'>;
type NativeReply=Omit<HostDaemonFrameOf<'workspace_integration_result'>,'type'|'request_id'>;
interface Journal {
 source:string;base:string;onto:string;prepared:string;conflicts:string[];merged?:string;no_changes?:boolean;publishing_commit?:string;preparing_tree?:string|null;
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
   const directory=join(configDir(),'workspace-native',locationId,key);
   const journalPath=join(directory,`${frame.workspace.execution_workspace.integration_id}.json`);
   const answerPath=join(directory,`request-${frame.operation_id}.json`);
   const {request_id:_,...meaning}=frame;
   const fingerprint=JSON.stringify(meaning);
   const prior=await readJson(answerPath);
   if(prior){if(prior.fingerprint!==fingerprint)return fail('native_integration_request_changed');const {type:_,request_id:__,...answer}=HostDaemonFrameSchema.parse({...prior.answer as object,type:'workspace_integration_result',request_id:frame.request_id}) as HostDaemonFrameOf<'workspace_integration_result'>;return answer;}
   let stored=await readJson(journalPath) as unknown as Journal|null;
   const treeOf=(commit:string)=>gitOrThrow(['rev-parse',`${commit}^{tree}`],root);
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
   let answer:NativeReply;
   if(stored?.merged){
    answer={...empty,ok:true,outcome:stored.no_changes?'no_changes':'merged',candidate_commit:stored.merged,onto_commit:stored.onto,error:null};
   }else if(frame.action==='native_checkpoint'){
    const commit=await snapshot(frame.message);
    answer={...empty,ok:true,outcome:'sealed',candidate_commit:commit,onto_commit:stored?.onto??null,error:null};
   }else if(frame.action==='native_prepare'){
    const source=await snapshot(frame.message),onto=await gitOrThrow(['rev-parse',`${frame.target_ref}^{commit}`],repo.root);
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
      await writeJson(journalPath,{source:sourceCommit,base,onto,prepared:source,conflicts:[],merged:onto,no_changes:true});
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
     const preparing={source:sourceCommit,base,onto,prepared:source,conflicts:merged.conflicted,preparing_tree:merged.tree};
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
    const commit=await snapshot(frame.message);
    if(await treeOf(commit)!==await treeOf(frame.verified_commit))return fail('native_verified_version_changed');
    const integrity=await runLocationGit(['diff','--check',stored.onto,commit,'--'],root);
    if(integrity.code!==0)return fail('native_candidate_has_unresolved_changes');
    const candidate=await writeCommit(repo.root,await treeOf(commit),stored.onto,frame.author,frame.message);
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
   if(saved){answer.source_commit=saved.source;answer.base_commit=saved.base;}
   await writeJson(answerPath,{fingerprint,answer});
   return answer;
  });
  return result??fail('task_busy');
 }catch(error){return fail(error instanceof Error?error.message:'native_integration_failed');}
 finally{release();active.delete(lease);}
}
