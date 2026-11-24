import {copyFile,lstat,mkdtemp,open,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {runLocationGit} from '@rainver/folder-read';
import {configDir} from './config.js';
import {fsyncDirectory,removeDurable,syncExistingDurable,writeJsonDurable} from './durableFile.js';

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
interface LocalPublicationJournal {root:string;onto:string;task:string;plans:Omit<Plan,'workFile'>[]}
const MAX_BLOB_BYTES=64*1024*1024;

export class LocalPublicationChanged extends Error {
 constructor(readonly paths: string[]){super('integration_local_recovery_changed');}
}

async function readIndexEntry(root:string,path:string):Promise<Entry|null|'unmerged'>{
 const result=await runLocationGit(['ls-files','-z','--stage','--',`:(literal)${path}`],root);
 if(result.code!==0||result.incomplete)throw new Error('integration_local_index_read_failed');
 if(!result.stdout)return null;
 const match=/^(\d{6}) ([0-9a-f]+) 0\t[^\0]+\0$/.exec(result.stdout);
 return match?{mode:match[1]!,blob:match[2]!}:'unmerged';
}

/** Use Git's index lock so a concurrent git add either precedes our comparison
 * or waits for the whole replacement. Update a copy to preserve unrelated entries. */
async function replaceIndexEntries(root:string,prepare:()=>Promise<Array<{path:string;entry:Entry|null;hashLength:number}>>):Promise<void>{
 const result=await runLocationGit(['rev-parse','--path-format=absolute','--git-path','index'],root);
 if(result.code!==0||!result.stdout.endsWith('\n'))throw new Error('integration_local_index_read_failed');
 const indexPath=result.stdout.slice(0,-1),lockPath=`${indexPath}.lock`;
 const alternate=join(dirname(indexPath),`.rainver-index-${randomUUID()}`);
 const lock=await open(lockPath,'wx');
 let committed=false;
 try{
  const entries=await prepare();
  if(!entries.length)return;
  await copyFile(indexPath,alternate).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});
  const input=entries.map(({path,entry,hashLength})=>`${entry?`${entry.mode} ${entry.blob}`:`0 ${'0'.repeat(hashLength)}`}\t${path}\0`).join('');
  const update=await runLocationGit(['update-index','-z','--index-info'],root,60000,{env:{GIT_INDEX_FILE:alternate},input});
  if(update.code!==0)throw new Error('integration_local_index_update_failed');
  await copyFile(alternate,lockPath);
  await lock.sync();
  await rename(lockPath,indexPath);
  committed=true;
  await fsyncDirectory(dirname(indexPath));
 }finally{
  await lock.close();
  if(!committed)await rm(lockPath,{force:true});
  await rm(alternate,{force:true});
 }
}

export function localPublicationJournalPath(gitCommonDir:string,targetRef:string):string{
 const key=createHash('sha256').update(JSON.stringify([gitCommonDir,targetRef])).digest('hex');
 return join(configDir(),'local-publications',`${key}.json`);
}

export async function readLocalPublication(file:string):Promise<LocalPublicationJournal|null>{
 if(!await syncExistingDurable(file))return null;
 return JSON.parse(await readFile(file,'utf8')) as LocalPublicationJournal;
}

/** Finish the exact admitted edit set after a crash. A fresh edit survives and keeps the journal fenced. */
export async function recoverLocalPublication(file:string,journal:LocalPublicationJournal,published:boolean):Promise<void>{
 const {root,onto,task,plans}=journal;
 const git=(args:string[])=>runLocationGit(args,root);
 const staysAtExpectedHead=async()=>(await git(['rev-parse','HEAD'])).stdout.trim()===(published?task:onto);
 const validate=async(p:LocalPublicationJournal['plans'][number])=>{
  const path=join(root,p.path),stat=await lstat(path).catch(()=>null);
  if(!stat?.isFile()||stat.isSymbolicLink()||(stat.mode&0o111?'100755':'100644')!==p.mode||await realpath(path)!==path)throw new Error('integration_local_recovery_changed');
  const work=await git(['hash-object','--no-filters','--',p.path]);
  const index=await readIndexEntry(root,p.path);
  const expectedIndex=new Set([p.index?.blob,p.theirs,published?p.mergedIndex:undefined]);
  const expectedWork=new Set([p.work,published?p.theirs:undefined,published?p.mergedWork:undefined]);
  if(work.code!==0||!expectedWork.has(work.stdout.trim())||index==='unmerged'||
    (index ? index.mode!==p.mode||!expectedIndex.has(index.blob) : p.index!==null))throw new LocalPublicationChanged([p.path]);
  return work.stdout.trim();
 };
 await replaceIndexEntries(root,async()=>{
  if(!await staysAtExpectedHead())throw new LocalPublicationChanged(plans.map(p=>p.path));
  for(const p of plans)await validate(p);
  return plans.map(p=>({path:p.path,entry:published?{mode:p.mode,blob:p.mergedIndex??p.theirs}:p.index,hashLength:p.theirs.length}));
 });
 for(const p of plans){
  if(!await staysAtExpectedHead())throw new Error('integration_local_recovery_changed');
  const currentWork=await validate(p);
  if(published&&p.mergedWork&&currentWork!==p.mergedWork){
   const out=await runLocationGit(['cat-file','blob',p.mergedWork],root,60000,{outputEncoding:'base64',maxOutputBytes:MAX_BLOB_BYTES});
   if(out.code!==0||out.incomplete)throw new Error('integration_local_file_write_failed');
   const path=join(root,p.path),temporary=join(dirname(path),`.rainver-local-${randomUUID()}`);
   const permissions=(await lstat(path)).mode&0o777;
   try{
    const handle=await open(temporary,'wx',0o600);
    try{await handle.writeFile(Buffer.from(out.stdout,'base64'));await handle.chmod(permissions);await handle.sync();}finally{await handle.close();}
    await validate(p);
    await rename(temporary,path);
    await fsyncDirectory(dirname(path));
   }finally{await rm(temporary,{force:true});}
  }
 }
 await removeDurable(file);
}

export async function reconcileLocalChanges(root:string,onto:string,task:string,paths:string[],journalPath:string):Promise<LocalChangeReconciliation>{
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
   const theirs=await treeEntry(task,path),base=await treeEntry(onto,path),index=await readIndexEntry(root,path);
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
 const journal=():LocalPublicationJournal=>({root,onto,task,plans:plans.map(({workFile:_,...plan})=>plan)});
 return {
  blocked,
  async stage(){
   try{
    const touched=plans.filter(p=>p.mergedWork||p.mergedIndex||p.work!==p.theirs);
    if(touched.length){
     for(const p of touched){if(await writeBlob(p.workFile)!==p.work)throw new LocalPublicationChanged([p.path]);}
     await retain('',touched.map(p=>({path:p.path,mode:p.mode,blob:p.work})));
     const staged=touched.filter(p=>p.index&&p.index.blob!==p.work);
     if(staged.length)await retain('-index',staged.map(p=>({path:p.path,mode:p.mode,blob:p.index!.blob})));
    }
    for(const p of plans){
     if(p.mergedIndex)p.mergedIndex=await writeBlob(p.mergedIndex);
     if(p.mergedWork)p.mergedWork=await writeBlob(p.mergedWork);
    }
    await replaceIndexEntries(root,async()=>{
     if((await git(['rev-parse','HEAD'])).stdout.trim()!==onto)throw new LocalPublicationChanged(plans.map(p=>p.path));
     for(const p of plans){
      const current=await readIndexEntry(root,p.path);
      if(current==='unmerged'||current?.mode!==p.index?.mode||current?.blob!==p.index?.blob)throw new LocalPublicationChanged([p.path]);
     }
     await writeJsonDurable(journalPath,journal());
     return plans.map(p=>({path:p.path,entry:{mode:p.mode,blob:p.theirs},hashLength:p.theirs.length}));
    });
   }finally{await rm(scratch,{recursive:true,force:true});}
  },
  async rollback(){
   await recoverLocalPublication(journalPath,journal(),false);
  },
  async finish(){
   await recoverLocalPublication(journalPath,journal(),true);
  },
 };
}
