import {AsyncLocalStorage} from 'node:async_hooks';
import {constants} from 'node:fs';
import {open,opendir,rm,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {configDir} from './config.js';
import {writeJsonDurable} from './durableFile.js';

/** Filesystem names have no portable durable readdir offset. Select the smallest
 * page above a name using a bounded max-heap, streaming directory entries only.
 * No full-directory array/sort or manifest read: O(page) memory, O(names log page)
 * enumeration. Name cursors survive unlink/reorder/restart; new earlier names
 * are visited on the next cycle. A failed item must not rewind the cursor. */
export async function workspaceFilePage(directory:string,after?:string,limit=256){
 if(!Number.isSafeInteger(limit)||limit<1||limit>512||after!==undefined&&(!after||Buffer.byteLength(after)>255||after.includes('/')||after.includes('\0')))throw new Error('workspace_page_invalid');
 const heap:string[]=[];let count=0;
 const compare=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
 const handle=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});
 if(!handle)return {names:[] as string[],next:undefined as string|undefined};
 try{for await(const entry of await opendir(process.platform==='linux'?`/proc/self/fd/${handle.fd}`:directory)){
  const name=entry.name;if(after!==undefined&&compare(name,after)<=0)continue;
  count++;
  if(heap.length<limit){
   heap.push(name);let i=heap.length-1;
   while(i>0){const p=(i-1)>>1;if(compare(heap[p]!,heap[i]!)>=0)break;[heap[p],heap[i]]=[heap[i]!,heap[p]!];i=p;}
  }else if(compare(name,heap[0]!)<0){
   heap[0]=name;let i=0;
   for(;;){let child=2*i+1;if(child>=heap.length)break;if(child+1<heap.length&&compare(heap[child+1]!,heap[child]!)>0)child++;if(compare(heap[i]!,heap[child]!)>=0)break;[heap[i],heap[child]]=[heap[child]!,heap[i]!];i=child;}
  }
 }}finally{await handle.close();}
 heap.sort(compare);return {names:heap,next:count>limit?heap.at(-1):undefined};
}
/** A pass shares its item/time budget across nested Location scans. Each
 * directory receives a small page slice before another owner is visited. */
const budgetContext=new AsyncLocalStorage<{left:number;until:number}>();
let continuation=false;
export function takeWorkspaceSweepContinuation(){const value=continuation;continuation=false;return value;}
let wake:(()=>void)|undefined;
export function onWorkspaceSweepContinuation(next:()=>void){wake=next;return ()=>{if(wake===next)wake=undefined;};}
export function requestWorkspaceSweepContinuation(){continuation=true;wake?.();}
let activeSweep:Promise<unknown>|undefined;
export function runWorkspaceSweep<T>(run:()=>Promise<T>):Promise<T>{
 // Reconnect callbacks share this process-wide guard, not merely a socket's
 // timer guard: the old connection may still be draining its final page.
 if(activeSweep)return activeSweep as Promise<T>;
 const result=budgetContext.run({left:2048,until:Date.now()+2000},run);activeSweep=result;
 void result.finally(()=>{if(activeSweep===result)activeSweep=undefined;}).catch(()=>{});
 return result;
}
/** Scheduling cursors carry no deletion authority. Completed frontiers are
 * unlinked, including empty owner directories; one-shot releases leave no
 * permanent per-operation scheduling file. */
export async function sweepWorkspaceFilePage(directory:string,label:string,visit:(name:string)=>Promise<void>,log:(line:string)=>void,limit=256,stateRoot=configDir(),parallel=1){
 const path=join(stateRoot,'workspace-sweeps',createHash('sha256').update(label+'\0'+directory).digest('hex')+'.json');
 let after:string|undefined;
 try{const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.size>4096)throw new Error('workspace_scan_cursor_invalid');const v=JSON.parse(await h.readFile('utf8'));if(v.after!==null&&typeof v.after!=='string')throw new Error('workspace_scan_cursor_invalid');after=v.after??undefined;}finally{await h.close();}}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')log(`workspace scan ${label}: restarting invalid scheduling cursor`);after=undefined;}
 if(after!==undefined&&(!after||Buffer.byteLength(after)>255||after.includes('/')||after.includes('\0'))){log(`workspace scan ${label}: restarting invalid scheduling cursor`);after=undefined;}
 const budget=budgetContext.getStore()??{left:1024,until:Date.now()+2000};
 for(let pages=0;pages<4;pages++){
  if(budget.left<=0||Date.now()>=budget.until){requestWorkspaceSweepContinuation();return after??'pending';}
  const page=await workspaceFilePage(directory,after,limit);
  let last=after,visited=0;
  while(visited<page.names.length&&budget.left>0&&Date.now()<budget.until){
   const chunk=page.names.slice(visited,visited+Math.min(parallel,budget.left));
   budget.left-=chunk.length;visited+=chunk.length;last=chunk.at(-1);
   await Promise.all(chunk.map(async name=>{try{await visit(name);}catch(e){log(`workspace scan ${label}/${name}: retained (${e instanceof Error?e.message:'read_failed'})`);}}));
  }
  if(visited<page.names.length&&last===undefined){await writeJsonDurable(path,{after:null,directory});requestWorkspaceSweepContinuation();return 'pending';}
  const next=visited<page.names.length?last:page.next;
  if(next===undefined){await rm(path,{force:true});return undefined;}
  await writeJsonDurable(path,{after:next,directory});after=next;
 }
 requestWorkspaceSweepContinuation();return after;
}

/** Upgrade old terminal frontiers too. Scheduling evidence never authorizes
 * deletion: forgetting a dormant cursor only repeats validated visits. */
export async function pruneIdleWorkspaceSweepCursors(now:number,log:(line:string)=>void){
 const dir=join(configDir(),'workspace-sweeps');
 const own=createHash('sha256').update('cursor-retirement'+'\0'+dir).digest('hex')+'.json';
 await sweepWorkspaceFilePage(dir,'cursor-retirement',async name=>{
  if(name===own||!/^([a-f0-9]{64})\.json$/.test(name))return;
  const path=join(dir,name),h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let value;let age=0;
  try{const info=await h.stat();if(!info.isFile()||info.size>4096)return;age=now-info.mtimeMs;value=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}
  if(!value||typeof value!=='object'||!(value.after===null||typeof value.after==='string'))return;
  const missing=typeof value.directory==='string'&&await lstat(value.directory).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e;});
  if(value.after===null||missing||age>30*86400_000)await rm(path,{force:true});
 },log);
}


/** Scheduling state only. Advance before starting a stage so one slow Git
 * inspection cannot make every following pass restart at the same phase. */
export async function runWorkspaceSweepStages(label:string,stages:Array<()=>Promise<unknown>>){
 const path=join(configDir(),'workspace-sweeps','phase-'+label+'.json');
 let start=0;
 try{const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await h.stat();if(st.isFile()&&st.size<=4096){const value=JSON.parse(await h.readFile('utf8'));if(Number.isSafeInteger(value.next)&&value.next>=0)start=value.next%stages.length;}}finally{await h.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')console.warn(`workspace phase ${label}: restarting unreadable scheduling cursor`);}
 for(let i=0;i<stages.length;i++){
  const budget=budgetContext.getStore();
  if(budget&&(budget.left<=0||Date.now()>=budget.until)){requestWorkspaceSweepContinuation();return;}
  const index=(start+i)%stages.length;
  await writeJsonDurable(path,{next:(index+1)%stages.length});
  await stages[index]!();
 }
}
