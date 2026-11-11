import {executeNativeWorkspaceIntegration} from './workspaceNativeIntegration.js';
import type {HostServerFrameOf} from '@rainver/protocol';
import {workspaceWorktreeKey} from './worktreeIdentity.js';
import {prepareTaskMerge,continueTaskMerge,finishTaskMerge,abortTaskMerge,sealMergeCandidate,preserveMergeCandidate,canAutomaticallyRepairMerge,prepareVerificationRepair,prepareConflictResolution} from './taskMerge.js';

/** Wire/owner adapter to the canonical merge machinery, never a Task wire frame. */
export async function executeWorkspaceIntegration(locationRoot:string|null,frame:HostServerFrameOf<'workspace_integration'>){
 if(frame.action.startsWith('native_'))return executeNativeWorkspaceIntegration(locationRoot,frame);
 const ref=frame.workspace.execution_workspace;
 const target={locationRoot,locationId:frame.workspace.workspace_location_id,taskId:workspaceWorktreeKey(ref),mergeId:ref.integration_id,
  sourceCommit:frame.source_commit,baseCommit:frame.base_commit,targetRef:frame.target_ref};
 const empty={main_branch:null,onto_commit:null,candidate_commit:null,conflicted_files:[] as string[]};
 if(frame.action==='repair'){
  const files=await (frame.repair_mode==='user_resolution'||frame.repair_mode==='agent_resolution'?prepareConflictResolution:prepareVerificationRepair)(target);
  return {...empty,ok:Boolean(files),outcome:files?'conflict' as const:null,conflicted_files:files??[],automatic_repair_allowed:Boolean(files),error:files?null:'integration_repair_scope_unavailable'};
 }
 if(frame.action==='preserve'){
  const commit=await preserveMergeCandidate({...target,author:frame.author});
  return {...empty,ok:Boolean(commit),outcome:commit?'sealed' as const:null,candidate_commit:commit,error:commit?null:'integration_evidence_unavailable'};
 }
 if(frame.action==='abort'){
  const result=await abortTaskMerge(target);return {...empty,...result,outcome:result.ok?'aborted' as const:null};
 }
 if(frame.action==='seal'){
  const ok=Boolean(frame.candidate_commit)&&await sealMergeCandidate({...target,candidateCommit:frame.candidate_commit!});
  return {...empty,ok,outcome:ok?'sealed' as const:null,error:ok?null:'integration_candidate_changed'};
 }
 if(frame.action==='finish'){
  if(!frame.onto_commit||!frame.candidate_commit)return {...empty,ok:false,outcome:null,error:'integration_finish_input_missing'};
  // A frozen chain plan is published as that chain, never as the squash candidate.
  const strategy=frame.publication_strategy??'squash';
  if(strategy!=='squash'&&(!frame.publication_chain_tip||!frame.publication_chain_length))return {...empty,ok:false,outcome:null,error:'native_publication_chain_unrecorded'};
  const publication=strategy==='squash'?undefined:{strategy,chainTip:frame.publication_chain_tip!,chainLength:frame.publication_chain_length!};
  const result=await finishTaskMerge({...target,mainBranch:frame.target_ref.replace(/^refs\/heads\//,''),ontoCommit:frame.onto_commit,taskCommit:frame.candidate_commit,publication});
  return {...empty,...result,candidate_commit:result.merged_commit,conflicted_files:result.overlapping_files};
 }
 const step=frame.action==='prepare'?await prepareTaskMerge({...target,author:frame.author,message:frame.message}):await continueTaskMerge(target);
 return {...step,candidate_commit:step.task_commit,automatic_repair_allowed:step.outcome==='conflict'?await canAutomaticallyRepairMerge(target):false};
}
