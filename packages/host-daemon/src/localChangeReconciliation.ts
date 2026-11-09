import {lstat,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runLocationGit} from '@rainver/folder-read';

/** Publication into a checked-out target carries the person's uncommitted edits
 * on overlapping files onto the published content, file by file, the way
 * `git pull --autostash` would, but without a stash: a three-way merge of the
 * working file (and of a staged version) between the current target content and
 * the published content. Only a merge that is not clean blocks that file. The
 * pre-publication content is retained under `refs/rainver/local-preimages/`. */
export interface LocalChangeReconciliation {
 /** Overlapping paths whose local state cannot be carried over cleanly. */
 blocked:string[];
 /** Before the fast-forward: point the index at the published blobs. */
 stage():Promise<void>;
 /** After a failed fast-forward: restore the original index entries. */
 rollback():Promise<void>;
 /** After the fast-forward: restore staged intent and write merged working files. */
 finish():Promise<void>;
}
interface Entry {mode:string;blob:string}
interface Plan {path:string;mode:string;theirs:string;index:Entry|null;work:string;workFile:string;mergedIndex:string|null;mergedWork:string|null}
const MAX_BLOB_BYTES=64*1024*1024;

export async function reconcileLocalChanges(root:string,onto:string,task:string,paths:string[]):Promise<LocalChangeReconciliation>{
 const git=(args:string[],env?:Record<string,string>)=>runLocationGit(args,root,60000,env?{env}:{});
 const scratch=await mkdtemp(join(tmpdir(),'rainver-local-'));
 const blocked:string[]=[],plans:Plan[]=[];
 let files=0;
 const blobFile=async(blob:string)=>{
  const out=await runLocationGit(['cat-file','blob',blob],root,60000,{outputEncoding:'base64',maxOutputBytes:MAX_BLOB_BYTES});
  if(out.code!==0||out.incomplete)return null;
  const file=join(scratch,`b${files++}`);await writeFile(file,Buffer.from(out.stdout,'base64'));return file;
 };
 const treeEntry=async(commit:string,path:string):Promise<Entry|null|'tree'>=>{
  const out=await git(['ls-tree','-z',commit,'--',`./${path}`]);
  const entry=/^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t/.exec(out.stdout);
  if(out.code!==0||!entry)return null;
  return entry[2]==='blob'?{mode:entry[1]!,blob:entry[3]!}:'tree';
 };
 const indexEntry=async(path:string):Promise<Entry|null|'unmerged'>=>{
  const out=await git(['ls-files','-z','--stage','--',`./${path}`]);
  const entry=/^(\d{6}) ([0-9a-f]+) (\d)\t/.exec(out.stdout);
  if(out.code!==0||!entry)return null;
  return entry[3]==='0'?{mode:entry[1]!,blob:entry[2]!}:'unmerged';
 };
 /** Three-way merge; the merged content's path in scratch, or null on conflict/binary. */
 const merge3=async(baseBlob:string,oursFile:string,theirsBlob:string):Promise<string|null>=>{
  const base=await blobFile(baseBlob),theirs=await blobFile(theirsBlob);
  if(!base||!theirs)return null;
  const ours=join(scratch,`m${files++}`);await writeFile(ours,await readFile(oursFile));
  const merged=await git(['merge-file','-q','-L','local','-L','target','-L','published',ours,base,theirs]);
  return merged.code===0?ours:null;
 };
 try{
  for(const path of paths){
   const info=await lstat(join(root,path)).catch(()=>null);
   const theirs=await treeEntry(task,path),base=await treeEntry(onto,path),index=await indexEntry(path);
   if(!info?.isFile()||info.isSymbolicLink()||!theirs||theirs==='tree'||base==='tree'||index==='unmerged'){blocked.push(path);continue;}
   const mode=info.mode&0o111?'100755':'100644';
   if(mode!==theirs.mode||(index&&index.mode!==theirs.mode)){blocked.push(path);continue;}
   const workFile=join(root,path),hashed=await git(['hash-object','--no-filters','--',path]);
   if(hashed.code!==0){blocked.push(path);continue;}
   const work=hashed.stdout.trim();
   if(!base){
    // Both add the path: only identical content is the published content already.
    if(work!==theirs.blob||(index&&index.blob!==theirs.blob)){blocked.push(path);continue;}
    plans.push({path,mode,theirs:theirs.blob,index,work,workFile,mergedIndex:null,mergedWork:null});continue;
   }
   if(!index){blocked.push(path);continue;} // tracked at the target but removed from the index
   let mergedIndex:string|null=null,mergedWork:string|null=null;
   if(index.blob!==base.blob&&index.blob!==theirs.blob){
    const staged=await blobFile(index.blob);
    mergedIndex=staged?await merge3(base.blob,staged,theirs.blob):null;
    if(!mergedIndex){blocked.push(path);continue;}
   }
   if(work!==base.blob&&work!==theirs.blob){
    mergedWork=await merge3(base.blob,workFile,theirs.blob);
    if(!mergedWork){blocked.push(path);continue;}
   }
   plans.push({path,mode,theirs:theirs.blob,index,work,workFile,mergedIndex,mergedWork});
  }
 }catch(error){await rm(scratch,{recursive:true,force:true});throw error;}
 if(blocked.length){await rm(scratch,{recursive:true,force:true});return {blocked,stage:async()=>{},rollback:async()=>{},finish:async()=>{}};}

 const writeBlob=async(file:string)=>{const out=await git(['hash-object','-w','--no-filters','--',file]);if(out.code!==0)throw new Error('integration_local_blob_write_failed');return out.stdout.trim();};
 /** A commit holding these paths' content over the target, kept as a recovery ref. */
 const retain=async(suffix:string,entries:Array<{path:string;mode:string;blob:string}>)=>{
  const env={GIT_INDEX_FILE:join(scratch,`index-${suffix||'work'}`)};
  if((await git(['read-tree',onto],env)).code!==0)throw new Error('integration_local_preimage_failed');
  for(const e of entries)if((await git(['update-index','--add','--cacheinfo',`${e.mode},${e.blob},${e.path}`],env)).code!==0)throw new Error('integration_local_preimage_failed');
  const tree=await git(['write-tree'],env);
  const identity={GIT_AUTHOR_NAME:'Rainver',GIT_AUTHOR_EMAIL:'rainver@localhost',GIT_COMMITTER_NAME:'Rainver',GIT_COMMITTER_EMAIL:'rainver@localhost'};
  const commit=await git(['commit-tree',tree.stdout.trim(),'-p',onto,'-m',`rainver: local changes before publishing ${task}`],identity);
  if(tree.code!==0||commit.code!==0)throw new Error('integration_local_preimage_failed');
  if((await git(['update-ref',`refs/rainver/local-preimages/${task}${suffix}`,commit.stdout.trim()])).code!==0)throw new Error('integration_local_preimage_failed');
 };
 const stillOnto=async()=>(await git(['rev-parse','HEAD'])).stdout.trim()===onto;
 const cacheinfo=(path:string,mode:string,blob:string)=>git(['update-index','--add','--cacheinfo',`${mode},${blob},${path}`]);
 return {
  blocked,
  async stage(){
   try{
    const touched=plans.filter(p=>p.mergedWork||p.mergedIndex||p.work!==p.theirs);
    if(touched.length){
     for(const p of touched)await writeBlob(p.workFile);
     await retain('',touched.map(p=>({path:p.path,mode:p.mode,blob:p.work})));
     const staged=touched.filter(p=>p.index&&p.index.blob!==p.work);
     if(staged.length)await retain('-index',staged.map(p=>({path:p.path,mode:p.mode,blob:p.index!.blob})));
    }
    for(const p of plans){
     if(p.mergedIndex)p.mergedIndex=await writeBlob(p.mergedIndex);
     if(p.mergedWork)p.mergedWork=await writeBlob(p.mergedWork);
     if((await cacheinfo(p.path,p.mode,p.theirs)).code!==0)throw new Error('integration_local_index_update_failed');
    }
   }finally{await rm(scratch,{recursive:true,force:true});}
  },
  async rollback(){
   // A concurrent ref change is somebody else's work; never undo it.
   if(!await stillOnto())return;
   for(const p of plans){
    const restored=p.index?await cacheinfo(p.path,p.index.mode,p.index.blob):await git(['update-index','--force-remove','--',p.path]);
    if(restored.code!==0)throw new Error('integration_local_index_restore_failed');
   }
  },
  async finish(){
   for(const p of plans){
    if(p.mergedIndex&&(await cacheinfo(p.path,p.mode,p.mergedIndex)).code!==0)throw new Error('integration_local_index_update_failed');
    if(p.mergedWork){
     const out=await runLocationGit(['cat-file','blob',p.mergedWork],root,60000,{outputEncoding:'base64',maxOutputBytes:MAX_BLOB_BYTES});
     if(out.code!==0||out.incomplete)throw new Error('integration_local_file_write_failed');
     await writeFile(p.workFile,Buffer.from(out.stdout,'base64'),{mode:p.mode==='100755'?0o755:0o644});
    }
   }
  },
 };
}
