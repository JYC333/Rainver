import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runLocationGit,validatePath,PathPolicyError,openFileBeneathRoot,SafeOpenError} from '@rainver/folder-read';
import {gitOrThrow,writeCommit,type LocationRepository} from './taskWorktree.js';

// Importing working bytes has its own bounds; the Folder preview cap is not a
// source-file limit (generated migration snapshots routinely exceed 1 MiB).
const MAX_PATHS=1000,MAX_CAPTURE_FILE_BYTES=16*1024*1024,MAX_CAPTURE_BYTES=64*1024*1024,MAX_CHECKOUT_BYTES=512*1024*1024;
const MAX_PROJECT_CONFIG_BYTES=4096;
// This is a narrow project-setting exception, not an npm INI parser. Never
// allow registry/auth settings, interpolation or arbitrary credential stores.
function assertProjectConfigAllowed(bytes:Buffer){
 if(bytes.length>MAX_PROJECT_CONFIG_BYTES||bytes.includes(0)||!bytes.toString('utf8').split(/\r?\n/).every(line=>
  /^[ \t]*(?:[#;][^\r\n]*|engine-strict[ \t]*=[ \t]*(?:true|false)[ \t]*)?$/.test(line)))
  throw new Error('workspace_checkout_project_config_not_allowed');
}
function assertCheckoutPathAllowed(root:string,path:string){
 try{validatePath({allowedRoot:root,path:join(root,path)});}
 catch(error){if(error instanceof PathPolicyError)throw new Error('workspace_checkout_forbidden_path');throw error;}
}
/** Refuse tracked credential files and symlinks before copying a checkout. */
export async function assertWorkspaceCheckoutAllowed(root:string,commit:string){
 const listed=await runLocationGit(['ls-tree','-r','-z','-l',commit],root,30000,{maxOutputBytes:8*1024*1024});
 if(listed.code!==0||listed.incomplete)throw new Error('workspace_checkout_inventory_unavailable');
 let total=0;
 for(const entry of listed.stdout.split('\0').filter(Boolean)){
  const tab=entry.indexOf('\t'),path=entry.slice(tab+1),fields=entry.slice(0,tab).trim().split(/\s+/);
  if(fields[0]==='120000')throw new Error('workspace_checkout_symlink_unsupported');
  if(path==='.npmrc'){
   if((fields[0]!=='100644'&&fields[0]!=='100755')||Number(fields[3])>MAX_PROJECT_CONFIG_BYTES)throw new Error('workspace_checkout_project_config_not_allowed');
   // Validate the selected immutable blob, never the source working copy.
   const blob=await runLocationGit(['cat-file','blob',fields[2]!],root,30000,{maxOutputBytes:MAX_PROJECT_CONFIG_BYTES,outputEncoding:'base64'});
   if(blob.code!==0||blob.incomplete)throw new Error('workspace_checkout_project_config_not_allowed');
   assertProjectConfigAllowed(Buffer.from(blob.stdout,'base64'));
  }else assertCheckoutPathAllowed(root,path);
  const bytes=Number(fields[3]);if(Number.isFinite(bytes))total+=bytes;
  if(total>MAX_CHECKOUT_BYTES)throw new Error('workspace_checkout_too_large');
 }
}
/** Allowed bytes are read from held handles and written through a private index.
 * Two equal captures/HEAD/status observations establish stability, not FS atomicity. */
export async function captureSourceBaseline(repo:LocationRepository){
 const scratch=await mkdtemp(join(tmpdir(),'rainver-source-baseline-'));
 try{
  for(let attempt=0;attempt<2;attempt++){
   const head=await gitOrThrow(['rev-parse','HEAD^{commit}'],repo.root);
   await assertWorkspaceCheckoutAllowed(repo.root,head);
   const status=await state(),first=await capture(head),second=await capture(head);
   if(first!==second||head!==await gitOrThrow(['rev-parse','HEAD^{commit}'],repo.root)||status!==await state())continue;
   const commit=await writeCommit(repo.root,first,head,{name:'Rainver',email:'rainver@localhost'},'Private workspace baseline');
   return {commit,tree:first,head};
  }
  throw new Error('waiting_for_baseline: source changed during capture');
 }finally{await rm(scratch,{recursive:true,force:true});}
 async function bounded(args:string[]){
  const result=await runLocationGit(args,repo.root,30000,{maxOutputBytes:2*1024*1024});
  if(result.code!==0||result.incomplete)throw new Error('workspace_snapshot_inventory_unavailable');return result.stdout;
 }
 async function state(){return bounded(['status','--porcelain=v1','-z','--untracked-files=all']);}
 async function capture(head:string){
  const tracked=(await bounded(['diff','--name-only','--no-renames','-z',head])).split('\0').filter(Boolean);
  const untracked=(await bounded(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  const paths=[...new Set([...tracked,...untracked])].sort();if(paths.length>MAX_PATHS)throw new Error('workspace_snapshot_too_many_files');
  const index=join(scratch,'index');await rm(index,{force:true});const env={GIT_INDEX_FILE:index};
  async function git(args:string[]){const r=await runLocationGit(args,repo.root,30000,{env});if(r.code!==0)throw new Error('workspace_snapshot_git_failed');return r.stdout.trim();}
  await git(['read-tree',head]);let total=0;
  for(const path of paths){
   const projectConfig=path==='.npmrc'&&!untracked.includes(path);
   if(!projectConfig)try{assertCheckoutPathAllowed(repo.root,path);}catch(error){if(untracked.includes(path))continue;throw error;}
   let handle;
   try{handle=await openFileBeneathRoot(repo.root,path.split('/'));}
   catch(error){if(error instanceof SafeOpenError){if(error.code==='not_found'){await git(['update-index','--force-remove','--',path]);continue;}if(error.code==='symlink')throw new Error('workspace_checkout_symlink_unsupported');}throw error;}
   try{
    const stat=await handle.stat();if(!stat.isFile())throw new Error('workspace_snapshot_special_file');
    if(projectConfig&&stat.size>MAX_PROJECT_CONFIG_BYTES)throw new Error('workspace_checkout_project_config_not_allowed');
    if(stat.size>MAX_CAPTURE_FILE_BYTES)throw new Error('workspace_snapshot_file_too_large');
    if(total+stat.size>MAX_CAPTURE_BYTES)throw new Error('workspace_snapshot_too_large');
    const bytes=Buffer.alloc(Math.min(MAX_CAPTURE_FILE_BYTES+1,stat.size+1));let length=0;
    while(length<bytes.length){const r=await handle.read(bytes,length,bytes.length-length,length);if(r.bytesRead===0)break;length+=r.bytesRead;}
    if(length!==stat.size)throw new Error('workspace_snapshot_file_changed');total+=length;
    if(projectConfig)assertProjectConfigAllowed(bytes.subarray(0,length));
    const blobFile=join(scratch,'blob');await writeFile(blobFile,bytes.subarray(0,length));
    const blob=await git(['hash-object','-w','--no-filters',blobFile]);
    await git(['update-index','--add','--cacheinfo',`${stat.mode&0o111?'100755':'100644'},${blob},${path}`]);
   }finally{await handle.close();}
  }
  return git(['write-tree']);
 }
}
