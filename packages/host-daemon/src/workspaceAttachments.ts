import {workspaceScopedCwd} from './workspaceScope.js';
import {existingTaskWorktree} from './taskWorktree.js';
import {workspaceWorktreeKey} from './worktreeIdentity.js';
import type {ExecutionWorkspaceRef,HostLaunchWorkspaceAccess,HostWorkspaceLaunchReport} from '@rainver/protocol';
import {prepareExecutionWorkspace} from './executionWorkspace.js';
import {checkLocationRepository,ownEntry,type TaskWorktree} from './taskWorktree.js';
import {resolveLocationCwd} from './execution.js';

export interface PreparedAttachment {
 ref:ExecutionWorkspaceRef;locationId:string;access:'read'|'write';
 worktree:TaskWorktree & {targetRef:string|null;baselineKind:string;snapshotHead:string|null;baselineTree:string|null;launchSequence:number};
}
export async function prepareWorkspaceAttachments(input:{
 attachments:HostLaunchWorkspaceAccess[];workspaces:Record<string,string>;sharedRoot:string|null;
 runId:string;launchId:string;onQueued:()=>void;
 primary?:{ref:ExecutionWorkspaceRef;locationId:string;worktree:TaskWorktree}|null;
 /** Repositories the caller holds at the repository gate and admitted; nothing else is prepared. */
 gated:ReadonlySet<string>;
}){
 const entries:Array<{workspace_location_id:string;access_mode:'read'|'write';path:string}>=[],prepared:PreparedAttachment[]=[];
 const repos=new Map<string,{ref:ExecutionWorkspaceRef;locationId:string;root:string}>();
 if(input.primary)repos.set(input.primary.worktree.gitCommonDir,{ref:input.primary.ref,locationId:input.primary.locationId,root:input.primary.worktree.root});
 for(const attachment of input.attachments){
  const source=resolveLocationCwd(input.workspaces,attachment.workspace_location_id,attachment.workspace_relative_path,input.sharedRoot);
  if(!source)throw new Error(attachment.workspace_relative_path?'An attached workspace escapes the shared workspace root':'This Host has no registered attached workspace');
  let path=source;
  if(attachment.execution_workspace){
   const check=await checkLocationRepository(source);if(check.kind!=='repository')throw new Error('execution_workspace_attachment_repository_unavailable');
   if(!input.gated.has(check.repo.gitCommonDir))throw new Error('execution_workspace_attachment_repository_not_gated');
   const existing=repos.get(check.repo.gitCommonDir),ref=attachment.execution_workspace;
   if(existing){
    if(existing.ref.id!==ref.id||existing.ref.generation!==ref.generation||existing.locationId!==attachment.workspace_location_id)throw new Error('execution_workspace_overlapping_aliases_require_canonical_location');
    path=existing.root;
   }else{
    const worktree=await prepareExecutionWorkspace(check.repo,attachment.workspace_location_id,ref,input.runId,{launchId:input.launchId,onQueued:input.onQueued});
    path=worktree.root;prepared.push({ref,locationId:attachment.workspace_location_id,access:attachment.access_mode,worktree});
    repos.set(check.repo.gitCommonDir,{ref,locationId:attachment.workspace_location_id,root:path});
   }
  }
  entries.push({workspace_location_id:attachment.mount_location_id??attachment.workspace_location_id,access_mode:attachment.access_mode,path:await workspaceScopedCwd(path,attachment.execution_workspace?.cwd_subpath)});
 }
 return {entries,prepared};
}
export function attachmentReports(prepared:PreparedAttachment[]):HostWorkspaceLaunchReport[]{
 return prepared.map(({ref,locationId,worktree:w})=>({id:ref.id,generation:ref.generation,workspace_location_id:locationId,branch:w.branch,start_commit:w.startCommit,target_ref:w.targetRef,baseline_kind:w.baselineKind as 'committed'|'snapshot',snapshot_head:w.snapshotHead,baseline_tree:w.baselineTree,launch_sequence:w.launchSequence}));
}
export async function attachmentGitBinds(prepared:PreparedAttachment[],readOnly:boolean){
 const binds:Array<{path:string;access_mode:'read'|'write'}>=[];
 for(const attachment of prepared){
  const w=attachment.worktree,entry=await ownEntry({root:w.locationRoot,gitCommonDir:w.gitCommonDir},w.root);
  if(!entry)throw new Error('execution_workspace_attachment_git_entry_unverified');
  binds.push({path:w.gitCommonDir,access_mode:'read'},{path:entry,access_mode:readOnly?'read':attachment.access});
 }
 return binds;
}

/** Verifiers consume existing pinned workspaces; never create a source fallback. */
export async function existingWorkspaceAttachments(attachments:HostLaunchWorkspaceAccess[],workspaces:Record<string,string>,sharedRoot:string|null){
 const entries:Array<{workspace_location_id:string;access_mode:'read'|'write';path:string}>=[],binds:Array<{path:string;access_mode:'read'|'write'}>=[];
 for(const attachment of attachments){
  if(!attachment.execution_workspace)throw new Error('execution_workspace_attachment_reference_required');
  const source=resolveLocationCwd(workspaces,attachment.workspace_location_id,attachment.workspace_relative_path,sharedRoot);
  if(!source)throw new Error(attachment.workspace_relative_path?'An attached workspace escapes the shared workspace root':'This Host has no registered attached workspace');
  const w=await existingTaskWorktree(source,attachment.workspace_location_id,workspaceWorktreeKey(attachment.execution_workspace));
  if(!w)throw new Error('execution_workspace_attachment_missing');
  const check=await checkLocationRepository(source);if(check.kind!=='repository')throw new Error('execution_workspace_repository_unavailable');
  const entry=await ownEntry(check.repo,w.root);if(!entry)throw new Error('execution_workspace_attachment_git_entry_unverified');
  entries.push({workspace_location_id:attachment.mount_location_id??attachment.workspace_location_id,access_mode:attachment.access_mode,path:await workspaceScopedCwd(w.root,attachment.execution_workspace.cwd_subpath)});
  binds.push({path:w.gitCommonDir,access_mode:'read'},{path:entry,access_mode:attachment.access_mode});
 }
 return {entries,binds};
}
