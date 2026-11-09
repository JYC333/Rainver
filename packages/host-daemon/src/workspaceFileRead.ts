import {isAbsolute,relative,join} from 'node:path';
import {runLocationGit,validatePath,MAX_FILE_BYTES} from '@rainver/folder-read';
import type {ExecutionWorkspaceRef} from '@rainver/protocol';
import {configDir} from './config.js';
import {workspaceWorktreeKey} from './worktreeIdentity.js';

/** Immutable blob read; never follows a worktree path or falls back to source files. */
export async function readWorkspaceFile(root:string,locationId:string,ref:ExecutionWorkspaceRef,commit:string,path:string){
 const privateRoot=join(configDir(),'task-worktrees',locationId,workspaceWorktreeKey(ref));
 if(isAbsolute(path)){
  const privateRelative=relative(privateRoot,path),sourceRelative=relative(root,path);
  path=validRelative(privateRelative)?privateRelative:validRelative(sourceRelative)?sourceRelative:'';
 }
 path=path.replace(/^\.\//,'');if(!validRelative(path)||/[\x00-\x1f\\]/.test(path))throw new Error('workspace_file_outside_scope');
 validatePath({allowedRoot:root,path:join(root,path)});
 const present=await versionPresence(root,commit);
 if(present==='missing')throw new Error('workspace_file_version_unavailable');
 if(present==='failed')throw new Error('workspace_file_read_failed');
 if(present!=='commit')throw new Error('workspace_file_unavailable');
 const listing=await runLocationGit(['ls-tree','-z','-l',commit,'--',`./${path}`],root,10000,{maxOutputBytes:8192});
 const entry=listing.stdout.split('\0').find(e=>e.slice(e.indexOf('\t')+1)===path),fields=entry?.slice(0,entry.indexOf('\t')).trim().split(/\s+/);
 if(listing.code!==0||listing.incomplete||!fields||!['100644','100755'].includes(fields[0]!)||fields[1]!=='blob')throw new Error('workspace_file_unavailable');
 const size=Number(fields[3]);if(!Number.isSafeInteger(size)||size>MAX_FILE_BYTES)throw new Error('workspace_file_too_large');
 const blob=await runLocationGit(['cat-file','blob',fields[2]!],root,10000,{maxOutputBytes:MAX_FILE_BYTES,outputEncoding:'base64'});
 if(blob.code!==0||blob.incomplete)throw new Error('workspace_file_unavailable');
 return {path,content_base64:blob.stdout};
}
function validRelative(path:string){return Boolean(path&&!isAbsolute(path)&&!path.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p));}

/**
 * Whether the exact version is present, from Git's machine-readable object
 * lookup. `cat-file --batch-check` answers `<oid> missing` for an object it
 * cannot find, and it answers the same way when a loose object cannot be
 * opened (permissions) or inflated (corruption) or an alternate is
 * unavailable. What separates those faults is that Git also reports them as
 * diagnostics. So only a clean run (exit 0, no signal, complete, no
 * diagnostics at all) whose answer is exactly `missing` means the version is
 * gone, which is the one answer that can become "expired". Any other run is a
 * read failure that keeps its own meaning. The diagnostic text is never
 * interpreted; only its presence counts.
 */
export async function versionPresence(root:string,commit:string):Promise<'commit'|'other'|'missing'|'failed'>{
 const probe=await runLocationGit(['cat-file','--batch-check=%(objectname) %(objecttype)'],root,10000,{input:`${commit}\n`,maxOutputBytes:4096});
 if(probe.code!==0||probe.incomplete||probe.stderr.trim())return 'failed';
 const answer=probe.stdout.replace(/\n$/,'');
 if(answer===`${commit} missing`)return 'missing';
 if(answer===`${commit} commit`)return 'commit';
 return answer.startsWith(`${commit} `)&&!answer.includes('\n')?'other':'failed';
}
