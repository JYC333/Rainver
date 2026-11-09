import {readdir,readFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {runLocationGit} from '@rainver/folder-read';
import {fsyncDirectory,fsyncExistingFile} from './durableFile.js';

/**
 * Exact reads and power-loss barriers for the protecting refs workspace
 * retention acknowledges (source keepers, re-pinned shared sources, Run
 * history). Git writes a ref with a lock file and a rename; `core.fsync`
 * (Git >= 2.36) can fsync the file, but Git never fsyncs the directories the
 * rename or a new ref path lives in, and an already-present ref with the
 * wanted oid is not rewritten at all. So before a protecting ref is reported
 * or another ref is deleted on its strength, its current storage is fsynced
 * here whether this Host just wrote it, an earlier failed attempt wrote it, or
 * an older Host version did: the loose file and each directory up to the
 * common Git directory, or `packed-refs` and the common directory, or every
 * reftable table and `tables.list`.
 *
 * Objects are Git's: the commit is checked present (`versionPresence`) by the
 * caller, and object files follow Git's own `core.fsync` policy (packs and
 * their indexes are fsynced by default since 2.36; loose objects are not).
 * Nothing here fsyncs the object store.
 */
export class RefReadError extends Error{
 constructor(readonly ref:string,detail:string){super('workspace_ref_read_failed');this.cause=detail;}
}

/**
 * The oid `name` holds, null only when Git cleanly answers that no such ref
 * exists. A failed read (exit, signal, timeout, any diagnostic) throws
 * `RefReadError`, so a fault is never taken for a deleted or absent ref.
 */
export async function readRef(repoRoot:string,name:string):Promise<string|null>{
 // `for-each-ref` answers an absent ref with exit 0 and no line; `rev-parse --quiet` cannot tell absence from a fault.
 const out=await runLocationGit(['for-each-ref','--format=%(objectname) %(refname)',name],repoRoot,30_000,{maxOutputBytes:64*1024});
 if(out.code!==0||out.incomplete||out.stderr.trim())throw new RefReadError(name,out.stderr.trim().slice(0,200)||`exit ${out.code}`);
 for(const line of out.stdout.split('\n')){
  const space=line.indexOf(' ');
  if(space>0&&line.slice(space+1)===name)return line.slice(0,space);
 }
 return null;
}

async function gitText(repoRoot:string,args:string[],name:string){
 const out=await runLocationGit(args,repoRoot);
 if(out.incomplete||out.stderr.trim()&&out.code!==1)throw new RefReadError(name,out.stderr.trim().slice(0,200));
 return out;
}

/**
 * Make `name` → `oid`, as Git stores it now, survive power loss. Throws
 * `RefReadError` when the storage cannot be found, read, fsynced, or no longer
 * names `oid` (the caller retries; it never reports the ref as kept).
 */
export async function syncRefDurable(repoRoot:string,name:string,oid:string):Promise<void>{
 try{
  const common=await gitText(repoRoot,['rev-parse','--path-format=absolute','--git-common-dir'],name);
  if(common.code!==0)throw new RefReadError(name,'git common directory unavailable');
  const commonDir=resolve(common.stdout.trim());
  const format=await gitText(repoRoot,['config','--get','extensions.refStorage'],name);
  if(format.code===0&&format.stdout.trim()==='reftable'){
   const tables=join(commonDir,'reftable');
   for(const entry of await readdir(tables))await fsyncExistingFile(join(tables,entry));
   await fsyncDirectory(tables);await fsyncDirectory(commonDir);
  }else{
   const loose=resolve(commonDir,name);
   if(relative(commonDir,loose).startsWith('..'))throw new RefReadError(name,'ref path outside the Git directory');
   if(await fsyncExistingFile(loose)){
    if((await readFile(loose,'utf8')).trim()!==oid)throw new RefReadError(name,'loose ref no longer holds the commit');
    // The file's entry, then each new directory's entry, up to the common directory.
    for(let dir=dirname(loose);;dir=dirname(dir)){
     await fsyncDirectory(dir);
     if(dir===commonDir||!dir.startsWith(commonDir+sep))break;
    }
   }else{
    const packed=join(commonDir,'packed-refs');
    if(!await fsyncExistingFile(packed))throw new RefReadError(name,'ref storage not found');
    if(!(await readFile(packed,'utf8')).split('\n').includes(`${oid} ${name}`))throw new RefReadError(name,'packed ref no longer holds the commit');
    await fsyncDirectory(commonDir);
   }
  }
 }catch(error){
  if(error instanceof RefReadError)throw error;
  throw new RefReadError(name,String((error as Error)?.message??error).slice(0,200));
 }
 // What Git resolves now is what was made durable.
 if(await readRef(repoRoot,name)!==oid)throw new RefReadError(name,'ref moved while it was synced');
}
