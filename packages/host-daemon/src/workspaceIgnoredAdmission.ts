import {constants} from 'node:fs';
import {open,opendir,lstat,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireLocationLeases,releaseLocationLeases} from './locationLease.js';

/** The daemon/owner CLI kernel lease excludes other processes. Within it the
 * existing FIFO lease serializes every manifest mutation for this Location,
 * including a preservation until its transaction commits or rolls back. No
 * directory timestamp stands in for the state of a child manifest. */
export async function acquireIgnoredAdmission(config:string,location:string){
 const key=`ignored-quota/${config}/${location}`,id=randomUUID();
 if(await acquireLocationLeases([key],{runId:id,launchId:id},()=>{})!=='acquired')throw new Error('workspace_ignored_quota_cancelled');
 return ()=>releaseLocationLeases([key],id);
}
/** Exact saturated active count under the admission lease. Directory reads and
 * manifest reads have explicit ceilings. An oversized/uncertain census is a
 * visible governance block, never an incomplete quota grant or endless retry.
 * Expiry/owner retirement can reduce it and the next request rechecks from disk. */
export async function ignoredAdmissionCount<T extends {state:string}>(_config:string,_location:string,locationDir:string,read:(base:string)=>Promise<T|null>,isRetired:(manifest:T,name:string)=>boolean){
 const h=await open(locationDir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 let names=0,manifests=0,count=0;
 try{for await(const entry of await opendir(`/proc/self/fd/${h.fd}`)){
  if(!entry.name.endsWith('-preserved-ignored'))continue;
  if(++names>16384)throw new Error('workspace_ignored_quota_inventory_limit');
  if(++manifests>512)throw new Error('workspace_ignored_scan_pending');
  let m:T|null;try{m=await read(join(locationDir,entry.name));}catch{m=null;}
  // A corrupt/unknown manifest consumes one active slot and remains visible
  // to ignored list/governance; it cannot poison unrelated free capacity.
  if(!m){if(++count>=128)return 128;continue;}
  if(m.state==='rolled_back')continue;
  let retired=false;try{retired=isRetired(m,entry.name);}catch{/* Uncertain retirement consumes quota. */}
  if(retired){
   const target=join(locationDir,entry.name.replace(/-preserved-ignored$/,'-retired-ignored'));
   // Never overwrite an unknown neighbour during compatibility migration.
   if(await lstat(target).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;})){if(++count>=128)return 128;continue;}
   await rename(join(locationDir,entry.name),target);
  }else if(++count>=128)return 128;
 }}finally{await h.sync();await h.close();}
 return count;
}
