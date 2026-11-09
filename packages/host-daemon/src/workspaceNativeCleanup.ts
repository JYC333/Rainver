import {readdir,rm,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {configDir} from './config.js';
import {readJson} from './taskWorktree.js';

/** Reclaim redundant receipts only after source cleanup; incomplete journals
 * and their preimages remain recoverable. Canonical outcomes live on the server. */
export async function cleanupNativeWorkspaceReceipts(locationId:string,key:string){
 const directory=join(configDir(),'workspace-native',locationId,key);
 const files:string[]=await readdir(directory).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});
 const completed=new Set<string>();
 for(const file of files){
  if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;
  const record=await readJson(join(directory,file));
  if(typeof record?.merged==='string')completed.add(file.slice(0,-5));
 }
 for(const file of files){
  if(!/^request-[a-f0-9-]{36}\.json$/.test(file))continue;
  const record=await readJson(join(directory,file));
  let request;try{request=JSON.parse(String(record?.fingerprint));}catch{continue;}
  const integration=request.workspace?.execution_workspace?.integration_id;
  if(completed.has(integration)||request.action==='native_checkpoint'&&!files.includes(`${integration}.json`))await rm(join(directory,file),{force:true});
 }
 for(const id of completed)await rm(join(directory,`${id}.json`),{force:true});
 await rmdir(directory).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT'&&error.code!=='ENOTEMPTY')throw error;});
}
