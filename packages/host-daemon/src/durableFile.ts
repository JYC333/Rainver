import {mkdir,open,rename,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,relative,isAbsolute,sep} from 'node:path';
import {configDir} from './config.js';

/**
 * Write-ahead records whose acknowledgement other machines rely on (workspace
 * ref operations, source keepers, materialization epochs, release journals).
 * `rename` alone is atomic against a crash of this process, not against power
 * loss: the new name and its bytes may still sit in the page cache. A durable
 * write therefore fsyncs the temporary file, renames it, then fsyncs the
 * parent directory, and makes every directory between the record and the
 * Host's config directory durable in its own parent. That chain is synced on
 * every write and replay until it once succeeded in this process (for the same
 * directory inode), not only when this write created it: an earlier `mkdir`
 * whose parent fsync failed leaves a directory a retry would otherwise trust.
 * The config directory itself is the trusted, pre-existing boundary; nothing
 * above it is synced. Any failure throws, so the caller never acknowledges a
 * record that may not survive. Ordinary receipts keep `writeJson`.
 *
 * Limits: this relies on the filesystem honouring fsync of files and
 * directories (ext4/xfs/apfs do; some network or virtual filesystems do not).
 */
export interface DurableIo {
 syncFile(handle:{sync():Promise<void>},path:string):Promise<void>;
 syncDirectory(path:string):Promise<void>;
 rename(from:string,to:string):Promise<void>;
}
const realIo:DurableIo={
 syncFile:(handle)=>handle.sync(),
 async syncDirectory(path){
  const handle=await open(path,'r');
  try{await handle.sync();}finally{await handle.close();}
 },
 rename:(from,to)=>rename(from,to),
};
let io:DurableIo=realIo;
/** Tests only: observe or fail individual sync/rename steps. Returns the restore function. */
export function setDurableIoForTest(next:Partial<DurableIo>){
 const prior=io;
 io={...realIo,...next};
 return ()=>{io=prior;};
}

/** Directories whose chain up to the config directory was synced, by path → inode. */
const durableChains=new Map<string,string>();
/** Tests only: forget which directory chains were already made durable (a fresh process). */
export function resetDurableDirectoriesForTest(){durableChains.clear();}
const inode=(s:{dev:number|bigint;ino:number|bigint})=>`${s.dev}:${s.ino}`;

/**
 * Create `dir` (0700) below the config directory and make it and every
 * ancestor up to that boundary durable: each one's entry is fsynced in its
 * parent, deepest first, whether this call or an earlier, failed one created it.
 */
async function durableDirectory(dir:string){
 const root=configDir(),rel=relative(root,dir);
 if(rel.startsWith('..')||isAbsolute(rel))throw new Error('durable_path_outside_config');
 if(!await stat(root).then(s=>s.isDirectory(),()=>false))throw new Error('durable_config_root_missing');
 await mkdir(dir,{recursive:true,mode:0o700});
 const id=inode(await stat(dir));
 if(durableChains.get(dir)===id)return;
 for(let current=dir,depth=rel?rel.split(sep).length:0;depth>0;current=dirname(current),depth--)await io.syncDirectory(dirname(current));
 durableChains.set(dir,id);
}

/** Write `value` as JSON so that, once this resolves, the record survives power loss. */
export async function writeJsonDurable(path:string,value:unknown):Promise<void>{
 const dir=dirname(path);
 await durableDirectory(dir);
 const temporary=`${path}.${randomUUID()}.tmp`;
 let renamed=false;
 try{
  const handle=await open(temporary,'wx',0o600);
  try{
   await handle.writeFile(JSON.stringify(value),'utf8');
   await io.syncFile(handle,temporary);
  }finally{await handle.close();}
  await io.rename(temporary,path);
  renamed=true;
  await io.syncDirectory(dir);
 }finally{
  if(!renamed)await rm(temporary,{force:true});
 }
}

/**
 * Before acknowledging an existing record (a replay, or a value equal to the one
 * a write would store), make sure it is durable: an earlier write that failed
 * after its rename, before its directory sync, or before its new directory's
 * parent sync, leaves a visible record that power loss may still discard. An
 * equal value is therefore never a reason to skip this barrier. Returns
 * whether the record exists.
 */
export async function syncExistingDurable(path:string):Promise<boolean>{
 const handle=await open(path,'r').catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
 if(!handle)return false;
 try{await io.syncFile(handle,path);}finally{await handle.close();}
 // Its directory may be one an earlier write created and failed to sync in its parent.
 await durableDirectory(dirname(path));
 await io.syncDirectory(dirname(path));
 return true;
}

/** fsync an existing file through the (test-observable) durable I/O layer; false when it does not exist. */
export async function fsyncExistingFile(path:string):Promise<boolean>{
 const handle=await open(path,'r').catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
 if(!handle)return false;
 try{await io.syncFile(handle,path);}finally{await handle.close();}
 return true;
}
/** fsync a directory through the durable I/O layer. */
export function fsyncDirectory(path:string):Promise<void>{return io.syncDirectory(path);}

/**
 * Remove a record so that, once this resolves, its absence survives power
 * loss: the unlink is followed by an fsync of its directory (and that
 * directory's chain). An already absent file is not a reason to skip the
 * barrier — a prior unlink whose directory sync failed leaves exactly that
 * state — so a retry always syncs again. Any failure throws.
 */
export async function removeDurable(path:string):Promise<void>{
 await rm(path,{force:true});
 await durableDirectory(dirname(path));
 await io.syncDirectory(dirname(path));
}
