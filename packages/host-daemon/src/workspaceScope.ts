import {realpath} from 'node:fs/promises';
import {join,relative,sep} from 'node:path';
import {runLocationGit} from '@rainver/folder-read';
import type {HostServerFrameOf} from '@rainver/protocol';
import {resolveLocationCwd} from './execution.js';
import {checkLocationRepository} from './taskWorktree.js';

/** Only a root explicitly included in this Run's grants may widen a subdirectory. */
export async function resolveWorkspaceScope(frame:HostServerFrameOf<'workspace_scope'>,workspaces:Record<string,string>,sharedRoot:string|null){
 const source=resolveLocationCwd(workspaces,frame.workspace.workspace_location_id,frame.workspace.workspace_relative_path,sharedRoot);
 if(!source)throw new Error('workspace_scope_location_missing');
 const physical=await realpath(source),top=await runLocationGit(['rev-parse','--show-toplevel'],physical);
 if(top.code!==0||top.incomplete)throw new Error('execution_workspace_repository_unavailable');
 const root=await realpath(top.stdout.trim()),check=await checkLocationRepository(root);
 if(check.kind!=='repository')throw new Error('execution_workspace_repository_unavailable');
 const candidates=[] as string[];
 for(const candidate of frame.candidates){
  const path=resolveLocationCwd(workspaces,candidate.workspace_location_id,candidate.workspace_relative_path,sharedRoot);
  if(path&&await realpath(path).catch(()=>null)===root)candidates.push(candidate.workspace_location_id);
 }
 const rootLocation=frame.preferred_location_id&&candidates.includes(frame.preferred_location_id)?frame.preferred_location_id:candidates.sort()[0];
 if(!rootLocation)throw new Error('workspace_subdirectory_requires_authorized_repository_root');
 const subpath=relative(root,physical).split(sep).join('/');
 if(subpath.startsWith('../')||subpath==='..')throw new Error('workspace_scope_outside_root');
 return {ok:true,error:null,root_location_id:rootLocation,cwd_subpath:subpath};
}
export async function workspaceScopedCwd(root:string,subpath?:string){
 if(!subpath)return root;
 if(subpath.startsWith('/')||subpath.includes('\\')||subpath.split('/').some(s=>s==='..'||s==='.'))throw new Error('workspace_scope_invalid');
 const path=join(root,subpath),physical=await realpath(path);
 if(physical!==path||!physical.startsWith(root+sep))throw new Error('workspace_scope_symlink_or_outside_root');
 return path;
}

/** Cross the wire with stable reasons, excluding raw filesystem diagnostics. */
export function publicWorkspaceError(error:unknown):string{
 const message=error instanceof Error?error.message:String(error);
 const code=message.split(/[:\s]/,1)[0]??'';
 return /^(?:workspace_|execution_workspace_|integration_|native_|waiting_for_baseline|task_busy$|location_busy$|main_checked_out_elsewhere$)/.test(code)&&/^[a-z_]+$/.test(code)?code:'workspace_host_operation_failed';
}

/** Launch failures can include fixed guidance without exposing file contents. */
export function publicWorkspaceLaunchError(error:unknown):string{
 const code=publicWorkspaceError(error);
 const guidance:Record<string,string>={
  workspace_snapshot_file_too_large:'A changed file exceeds the 16 MiB private snapshot limit. Choose the committed version or reduce the file before including current changes.',
  workspace_snapshot_too_large:'Changed files exceed the 64 MiB private snapshot limit. Choose the committed version or reduce the snapshot before including current changes.',
  workspace_checkout_project_config_not_allowed:'The root project .npmrc contains unsupported settings. Only engine-strict=true/false and comments are supported. Keep authentication settings outside the repository.',
  workspace_checkout_forbidden_path:'The selected code version contains a protected credential path. Remove credential files from the repository before starting an isolated workspace.',
  workspace_checkout_symlink_unsupported:'The selected code version or snapshot contains a symbolic link, which isolated workspace preparation does not support.',
 };
 return guidance[code]?`${code}: ${guidance[code]}`:code;
}
