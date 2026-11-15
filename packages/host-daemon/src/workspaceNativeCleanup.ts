import {rm,rmdir,lstat,open,constants} from 'node:fs/promises';
import {join} from 'node:path';
import {configDir} from './config.js';
import {sweepWorkspaceFilePage} from './workspaceFilePages.js';

const COMMIT=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
async function record(path:string):Promise<Record<string,any>|null>{
 try{const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{
  const s=await h.stat();if(!s.isFile()||s.size>2*1024*1024)throw new Error('workspace_receipt_invalid');
  return JSON.parse(await h.readFile('utf8'));
 }finally{await h.close();}}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
/** Reclaim one page after source cleanup. Incomplete journals and their
 * preimages remain recoverable. Hourly expiry continues pages not visited by
 * the release RPC, using the source's completed-release fence. */
export async function cleanupNativeWorkspaceReceipts(locationId:string,key:string,options:{now?:number;log?:(line:string)=>void;released?:boolean}={}){
 const directory=join(configDir(),'workspace-native',locationId,key),log=options.log??(()=>{});
 const next=await sweepWorkspaceFilePage(directory,'native-'+locationId+'-'+key,async file=>{
  if(!/^(?:request-)?[a-f0-9-]{36}\.json$/.test(file))return;
  const path=join(directory,file);
  if(options.now!==undefined&&options.now-(await lstat(path)).mtimeMs<=30*86400_000)return;
  const value=await record(path);if(!value)return;
  if(!file.startsWith('request-')){
   if(typeof value.merged==='string'&&COMMIT.test(value.merged))await rm(path,{force:true});
   return;
  }
  let request;try{request=JSON.parse(String(value.fingerprint));}catch{return;}
  const integration=request.workspace?.execution_workspace?.integration_id;
  if(typeof integration!=='string'||!/^([a-f0-9-]{36})$/.test(integration))return;
  const journal=await record(join(directory,`${integration}.json`));
  // Never remove the only answer to an interrupted publication/preparation.
  // A missing completed journal may have been on an earlier sweep page.
  if(journal?typeof journal.merged==='string'&&COMMIT.test(journal.merged)
   :request.action==='native_checkpoint'||options.released&&value.answer?.ok===true)await rm(path,{force:true});
 },log);
 await rmdir(directory).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT'&&error.code!=='ENOTEMPTY')throw error;});
 return next;
}
