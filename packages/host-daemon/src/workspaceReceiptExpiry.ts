import {constants} from 'node:fs';
import {lstat,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {configDir} from './config.js';
import {workspaceIdentity} from './worktreeIdentity.js';
import {readRunRecord,taskLeaseKey,validTaskWorktreeIds,withTaskHeld} from './taskWorktree.js';
import {pruneIdleWorkspaceSweepCursors,runWorkspaceSweepStages,sweepWorkspaceFilePage} from './workspaceFilePages.js';

let beforeLease:((path:string)=>Promise<void>)|undefined;
export function setReceiptExpiryBeforeLeaseForTest(next:typeof beforeLease){const prior=beforeLease;beforeLease=next;return ()=>{beforeLease=prior;};}
const COMMIT=/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RETENTION=30*86400_000;
/** Generic replies need a proven, completed owner release. Age alone cannot
 * remove offline recovery evidence. Cleanup journals become inert tombstones:
 * replay of an old physical-only request must never act on a rebuilt tree. */
export async function pruneWorkspaceReceipts(now:number,log:(line:string)=>void){
 await runWorkspaceSweepStages('receipts',[()=>pruneIdleWorkspaceSweepCursors(now,log),async()=>{
 // Release-scoped immediate work has no age delay. A rebuild invalidates its
 // old authority; it cannot delete new replies just because their names match.
 await sweepWorkspaceFilePage(join(configDir(),'workspace-receipt-reclaims'),'receipt-reclaims',async name=>{
  if(!/^[a-f0-9]{64}\.json$/.test(name))return;
  const path=join(configDir(),'workspace-receipt-reclaims',name);
  const {readJson}=await import('./taskWorktree.js');
  const intent=await readJson(path),location=intent?.location,key=intent?.key;
  if(typeof location!=='string'||typeof key!=='string'||!validTaskWorktreeIds(location,key)||!workspaceIdentity(key))return;
  await withTaskHeld(taskLeaseKey(location,key),async()=>{
   const {releasedReceiptMayExpire,reclaimWorkspaceReceipts,rebuiltSinceRelease}=await import('./workspaceRetention.js');
   const ref=intent?.ref as import('@rainver/protocol').ExecutionWorkspaceRef|undefined;
   if(!ref||ref.id!==workspaceIdentity(key)?.id||ref.generation!==workspaceIdentity(key)?.generation||ref.integration_id||!Number.isSafeInteger(ref.materialization_epoch))return;
   if(await rebuiltSinceRelease(location,key,ref.materialization_epoch!)){await rm(path,{force:true});return;}
   if(await releasedReceiptMayExpire(location,key))await reclaimWorkspaceReceipts(location,key,ref);
  });
 },log);
 },...['task-runs' ,'task-merges','workspace-launches','workspace-cleanup'].map(kind=>async()=>{
  const directory=join(configDir(),kind);
  await sweepWorkspaceFilePage(directory,'receipts-'+kind,async name=>{
   if(!name.endsWith('.json'))return;
   const path=join(directory,name),info=await lstat(path);
   if(!info.isFile())return;
   const aged=now-info.mtimeMs>RETENTION;
   const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   let receipt:Record<string,unknown>;
   try{const st=await h.stat();if(!st.isFile()||st.ino!==info.ino||st.dev!==info.dev||st.size>2*1024*1024)return;receipt=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}
   if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))return;
   const owner=workspaceIdentity(String(receipt.task_id??''));
   if(typeof receipt.task_id==='string'&&receipt.task_id.startsWith('workspace:')&&!owner)return;
   const launch=kind==='workspace-launches'&&typeof receipt.generation==='number'&&typeof receipt.id==='string';
   const cleanup=kind==='workspace-cleanup';
   if(cleanup&&(!aged||!['cleaned','expired'].includes(String(receipt.state))))return;
   const scope=cleanup?receipt.owner as {location_id?:unknown;key?:unknown;epoch?:unknown}|undefined:undefined;
   const key=scope?.key??(owner?receipt.task_id:launch?`workspace:${receipt.id}:${receipt.generation}`:null);
   const location=scope?.location_id??(owner?receipt.location_id:launch?receipt.workspace_location_id:null);
   if(owner||launch||cleanup){
    if(typeof location!=='string'||typeof key!=='string'||!validTaskWorktreeIds(location,key)){if(cleanup)log(`workspace cleanup ${name} retained: workspace_cleanup_owner_unknown; owner review required`);return;}
    if(kind==='task-runs'&&!await readRunRecord(name.slice(0,-5)))return;
    if(kind==='task-merges'&&(typeof receipt.merged_commit!=='string'||!COMMIT.test(receipt.merged_commit)))return;
    if(launch&&(typeof receipt.start_commit!=='string'||!COMMIT.test(receipt.start_commit)))return;
    await beforeLease?.(path);
    await withTaskHeld(taskLeaseKey(location,key),async()=>{
     if(!await unchangedReceipt(path,info,receipt))return;
     const {releasedReceiptMayExpire}=await import('./workspaceRetention.js');
     if(!await releasedReceiptMayExpire(location,key))return;
     if(cleanup){
      if(receipt.digest_version!==2||typeof receipt.fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(receipt.fingerprint))return;
      const {recordedMaterializationEpoch}=await import('./workspaceRetention.js');
      if(!Number.isSafeInteger(scope?.epoch)||Number(scope?.epoch)>=await recordedMaterializationEpoch(location,key))return;
      // The durable owner epoch now rejects this old physical request before
      // any side effect. It replaces each operation's tombstone, not its digest.
      await rm(path,{force:true});
     }else await rm(path,{force:true});
    });
   }else if(aged&&kind!=='workspace-launches'){
    // Recognised legacy terminal replies only. Arbitrary/corrupt JSON is not
    // a receipt and never inherits a valid neighbour's expiry.
    if(kind==='task-runs'&&!await readRunRecord(name.slice(0,-5)))return;
    if(kind==='task-merges'&&(typeof receipt.merged_commit!=='string'||!COMMIT.test(receipt.merged_commit)))return;
    const legacyKey=receipt.task_id,legacyLocation=receipt.location_id;
    if(typeof legacyKey!=='string'||typeof legacyLocation!=='string'||!validTaskWorktreeIds(legacyLocation,legacyKey))return;
    await withTaskHeld(taskLeaseKey(legacyLocation,legacyKey),async()=>{
     if(!await unchangedReceipt(path,info,receipt))return;
     for(const live of [join(configDir(),'task-records',legacyLocation,`${legacyKey}.json`),join(configDir(),'task-records',legacyLocation,`${legacyKey}.merge.json`),join(configDir(),'task-worktrees',legacyLocation,legacyKey)]){
      try{await lstat(live);return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
     }
     await rm(path,{force:true});
    });
   }
  },log).catch(error=>log(`workspace receipts ${kind}: retained (${error instanceof Error?error.message:'scan_failed'})`));
 }),...['workspace-native','workspace-baselines','workspace-sequences'].map(kind=>async()=>{
  await sweepWorkspaceFilePage(join(configDir(),kind),kind+'-locations',async location=>{
   if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(location))return;
   await sweepWorkspaceFilePage(join(configDir(),kind,location),kind+'-owners-'+location,async name=>{
    const key=kind==='workspace-native'?name:name.endsWith('.json')?name.slice(0,-5):'';
    if(!workspaceIdentity(key))return;
    await withTaskHeld(taskLeaseKey(location,key),async()=>{
     const {releasedReceiptMayExpire}=await import('./workspaceRetention.js');
     if(!await releasedReceiptMayExpire(location,key))return;
     if(kind==='workspace-native'){
      const {cleanupNativeWorkspaceReceipts}=await import('./workspaceNativeCleanup.js');
      await cleanupNativeWorkspaceReceipts(location,key,{now,log,released:true});
     }else{
      const path=join(configDir(),kind,location,name),st=await lstat(path);
      if(!st.isFile()||now-st.mtimeMs<=RETENTION)return;
      const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      let value;try{const actual=await h.stat();if(!actual.isFile()||actual.ino!==st.ino||actual.dev!==st.dev||actual.size>4096)return;value=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}
      if(!value||typeof value!=='object'||Array.isArray(value))return;
      if(kind==='workspace-sequences'?!Number.isSafeInteger(value.sequence)||value.sequence<0:!['snapshot','committed'].includes(value.kind))return;
      await rm(path,{force:true});
     }
    });
   },log);
  },log).catch(error=>log(`workspace receipts ${kind}: retained (${error instanceof Error?error.message:'scan_failed'})`));
 })]);
}

/** Re-read after acquiring the same writer lease; a pre-lock observation is
 * never authority to unlink/replace a receipt rewritten while waiting. */
export async function unchangedReceipt(path:string,before:Awaited<ReturnType<typeof lstat>>,value:Record<string,unknown>){
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const current=await h.stat();
  if(!current.isFile()||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeMs!==before.mtimeMs||current.ctimeMs!==before.ctimeMs)return false;
  if(JSON.stringify(JSON.parse(await h.readFile('utf8')))!==JSON.stringify(value))return false;
  const visible=await lstat(path);return visible.dev===current.dev&&visible.ino===current.ino&&visible.mtimeMs===current.mtimeMs&&visible.ctimeMs===current.ctimeMs;
 }finally{await h.close();}
}
