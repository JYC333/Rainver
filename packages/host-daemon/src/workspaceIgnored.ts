import {acquireIgnoredAdmission,ignoredAdmissionCount} from './workspaceIgnoredAdmission.js';
import {constants} from 'node:fs';
import {lstat,mkdir,open,opendir,rename,rm,rmdir,type FileHandle} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {runLocationGit,looksSecretLikePath} from '@rainver/folder-read';
import {writeJsonDurable} from './durableFile.js';
import {workspaceFilePage,sweepWorkspaceFilePage} from './workspaceFilePages.js';

let fault:((stage:'journal'|'moved'|'preserved')=>Promise<void>)|undefined;
/** Deterministic filesystem boundary injection, restored by the test. */
export function setIgnoredFaultForTest(next:typeof fault){const old=fault;fault=next;return ()=>{fault=old;};}
const LIMIT=1024*1024*1024;
const SEGMENT=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
interface Manifest {version:2;location_id:string;workspace_key:string;original_root:string;paths:string[];state:'preserving'|'preserved'|'rolled_back'|'frozen';retention:'owner_review';bytes:number;retired_paths?:string[];retired_at?:string;blocked_reason?:string}
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const fdPath=(h:FileHandle)=>`/proc/self/fd/${h.fd}`;
async function directory(path:string){return open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}
async function sync(path:string){const h=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|(/^\/proc\/self\/fd\/\d+$/.test(path)?0:constants.O_NOFOLLOW));try{await h.sync();}finally{await h.close();}}
async function readManifest(base:string):Promise<Manifest|null>{
 try{const dir=await directory(base);try{const h=await open(join(fdPath(dir),'manifest.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=await h.stat();if(!info.isFile()||info.size>2*1024*1024)throw new Error('workspace_ignored_manifest_invalid');return JSON.parse(await h.readFile('utf8'));}finally{await h.close();}}finally{await dir.close();}}catch(e){if(missing(e))return null;throw e;}
}
async function realDir(path:string,create=false){
 if(create)await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 const h=await directory(path);await h.close();
}
/** Git folds fully ignored directories. node_modules is never enumerated. The
 * bounded list describes roots, not every generated js/d.ts/map below them. */
async function ignored(root:string){
 const r=await runLocationGit(['ls-files','--others','--ignored','--exclude-standard','--directory','-z'],root,30_000,{maxOutputBytes:128*1024});
 if(r.code!==0||r.incomplete)throw new Error('workspace_uncaptured_ignored');
 const paths=r.stdout.split('\0').filter(Boolean).map(p=>p.replace(/\/$/,'')) .filter(p=>!p.split('/').includes('node_modules'));
 if(paths.length>2000||paths.some(p=>p.split('/').some(s=>!s||s==='.'||s==='..')))throw new Error('workspace_uncaptured_ignored');
 // Git may report overlapping folded roots. A manifest must move each inode
 // once, especially when splitting an ancestor around nested dependencies.
 const roots:string[]=[];
 for(const path of [...new Set(paths)].sort((a,b)=>a.length-b.length||a.localeCompare(b)))
  if(!roots.some(root=>within(path,root)))roots.push(path);
 return roots;
}
/** Open every ancestor without following links, and keep it open through rename
 * and rollback. Linux fd-relative paths bind rename to these directory inodes. */
async function parent(root:string,path:string,create=false){
 const handles:FileHandle[]=[];let h=await directory(root);handles.push(h);
 try{
  for(const segment of path.split('/').slice(0,-1)){
   const next=join(fdPath(h),segment);
   if(create)await mkdir(next,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   h=await directory(next);handles.push(h);
  }
  return {path:join(fdPath(h),path.split('/').at(-1)!),handles,async check(){
   let visible=root;
   for(let i=0;i<handles.length;i++){
    const a=await handles[i]!.stat(),b=await lstat(visible);
    if(!b.isDirectory()||a.ino!==b.ino||a.dev!==b.dev)throw new Error('workspace_ignored_path_changed');
    visible=join(visible,path.split('/')[i]!);
   }
  },async close(){for(const handle of handles.reverse())await handle.close();}};
 }catch(e){for(const handle of handles.reverse())await handle.close();throw e;}
}
/** Streaming accounting/fsync: bounded depth and bytes; links remain links.
 * A nested dependency tree is opaque, rather than millions of file visits. */
async function durableSize(path:string,depth=0):Promise<number>{
 if(depth>64)throw new Error('workspace_ignored_depth');
 const st=await lstat(path);
 if(st.isSymbolicLink())return st.size;
 if(st.isFile()){
  const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const now=await h.stat();if(now.ino!==st.ino||now.dev!==st.dev)throw new Error('workspace_ignored_path_changed');await h.sync();return now.size;}finally{await h.close();}
 }
 if(!st.isDirectory())throw new Error('workspace_uncaptured_ignored');
 const h=await directory(path);let total=0;
 try{
  const stream=await opendir(fdPath(h));
  for await(const entry of stream){
   // A dependency directory is disposable under the existing Host policy.
   if(entry.name==='node_modules')throw new Error('workspace_ignored_nested_dependencies');
   total+=await durableSize(join(fdPath(h),entry.name),depth+1);
   if(total>LIMIT)throw new Error('workspace_ignored_quota');
  }
  await h.sync();return total;
 }finally{await h.close();}
}
/** Git folds ignored ancestors such as server/server/. Split only the paths
 * containing dependency directories, so the existing disposable node_modules
 * rule applies at every depth without losing unknown siblings. Never enter a
 * dependency tree or follow a symlink; unchanged build roots stay folded. */
async function splitDependencyRoots(root:string,paths:string[]):Promise<string[]>{
 let remaining=100000;
 const visit=async(path:string,physical:string,depth:number):Promise<{paths:string[];split:boolean}>=>{
  if(depth>64||--remaining<0)throw new Error('workspace_ignored_scan_limit');
  if(path.split('/').at(-1)==='node_modules')return {paths:[],split:true};
  const st=await lstat(physical);
  if(!st.isDirectory()||st.isSymbolicLink())return {paths:[path],split:false};
  const h=await directory(physical);let split=false;const children:string[]=[];
  try{for await(const entry of await opendir(fdPath(h))){
   const child=await visit(path+'/'+entry.name,join(fdPath(h),entry.name),depth+1);
   split ||= child.split;children.push(...child.paths);
  }}finally{await h.close();}
  if(split&&children.length>2000)throw new Error('workspace_ignored_scan_limit');
  return {paths:split?children:[path],split};
 };
 const result:string[]=[];
 for(const path of paths){const p=await parent(root,path);try{result.push(...(await visit(path,p.path,0)).paths);}finally{await p.close();}}
 if(result.length>2000)throw new Error('workspace_ignored_scan_limit');
 return result;
}
async function preservationRoots(root:string,prefixes:string[]){
 return splitDependencyRoots(root,await splitDeclaredRoots(root,await ignored(root),prefixes));
}
export interface IgnoredTransaction {commit():Promise<void>;rollback():Promise<void>}
/** One stable manifest per generation. Retry first rolls an interrupted move
 * back; no UUID directories or copies accumulate. Unknown assets never expire.
 * Caller rolls back if the final dirty check fails, before retiring the tree. */
export async function preserveIgnoredWorkspaceFiles(root:string,config:string,location:string,key:string):Promise<IgnoredTransaction>{
 const release=await acquireIgnoredAdmission(config,location);
 try{
  const tx=await preserveIgnoredFilesHeld(root,config,location,key);
  return {async commit(){await tx.commit();release();},async rollback(){try{await tx.rollback();}finally{release();}}};
 }catch(e){release();throw e;}
}
async function preserveIgnoredFilesHeld(root:string,config:string,location:string,key:string):Promise<IgnoredTransaction>{
 if(process.platform!=='linux'||!SEGMENT.test(location)||!SEGMENT.test(key))throw new Error('workspace_uncaptured_ignored');
 await realDir(root);await realDir(config);
 const container=join(config,'task-worktrees-quarantine');await realDir(container,true);
 const locationDir=join(container,location);await realDir(locationDir,true);
 const base=await ignoredBase(locationDir,key),files=join(base,'files');
 const blocked=join(locationDir,`${key}-blocked-ignored.json`);
 const recordBlocked=async(error:unknown)=>writeJsonDurable(blocked,{version:2,location_id:location,workspace_key:key,original_root:root,paths:[],state:'rolled_back',retention:'owner_review',bytes:0,blocked_reason:String(error)});
 const prior=await readManifest(base);
 if(prior&&prior.original_root!==root)throw new Error('workspace_ignored_identity');
 if(prior?.state==='frozen')throw new Error('workspace_ignored_owner_review');
 // Commit may have survived a crash before worktree removal. Empty source is
 // the exact replay case; a new ignored file requires owner reconciliation.
 if(prior?.state==='preserved'){if(!(await preservationRoots(root,await readDeclarations(config,location))).length)return {async commit(){},async rollback(){}};throw new Error('workspace_ignored_owner_review');}
 // Recovery uses exactly the journal's source/destination pairs. A collision
 // is preserved and frozen for owner recovery, never overwritten.
 if(prior?.state==='preserving')await restoreManifest(base,prior);
 const declarations=await readDeclarations(config,location);
 const paths=await preservationRoots(root,declarations);
 if(!paths.length)return {async commit(){},async rollback(){}};
 let count:number;try{count=await ignoredAdmissionCount(config,location,locationDir,readManifest,(m,name)=>{validateRetiredManifest(m,location,name);return m.state==='preserved'&&Number.isFinite(Date.parse(m.retired_at??''))&&m.paths.every(p=>m.retired_paths!.includes(p));});}catch(e){await recordBlocked(e);throw e;}
 if(count>=128){await recordBlocked('workspace_ignored_quota');throw new Error('workspace_ignored_quota');}
 await rm(blocked,{force:true});
 await realDir(base,true);await realDir(files,true);
 let manifest:Manifest={version:2,location_id:location,workspace_key:key,original_root:root,paths,state:'preserving',retention:'owner_review',bytes:0};
 const moves:Array<{source:Awaited<ReturnType<typeof parent>>;destination:Awaited<ReturnType<typeof parent>>;moved:boolean;inode:number;dev:number}>=[];
 const close=async()=>{for(const m of moves){await m.source.close();await m.destination.close();}};
 const rollback=async()=>{
  try{
   for(const m of [...moves].reverse())if(m.moved){
    if(await lstat(m.source.path).catch(e=>{if(missing(e))return null;throw e;}))throw new Error('workspace_ignored_restore_collision');
    await rename(m.destination.path,m.source.path);m.moved=false;
    await sync(dirname(m.source.path));await sync(dirname(m.destination.path));
   }
   manifest={...manifest,state:'rolled_back'};await writeJsonDurable(join(base,'manifest.json'),manifest);
   await rm(base,{recursive:true});await sync(locationDir);
  }catch(e){manifest={...manifest,state:'frozen'};await writeJsonDurable(join(base,'manifest.json'),manifest);throw e;}
  finally{await close();}
 };
 try{
  for(const path of paths){
   const source=await parent(root,path);
   let destination:Awaited<ReturnType<typeof parent>>;
   try{destination=await parent(files,path,true);}catch(e){await source.close();throw e;}
   const st=await lstat(source.path);moves.push({source,destination,moved:false,inode:st.ino,dev:st.dev});
   if(declarations.some(prefix=>within(path,prefix))){
    // Explicit directory-root authority: same-filesystem move, bounded root
    // count and finite retention, without scanning/copying a multi-GiB cache.
    await validateDeclaredTree(source.path);
    (manifest.retired_paths??=[]).push(path);
   }else manifest.bytes+=await durableSize(source.path);
   if(manifest.bytes>LIMIT)throw new Error('workspace_ignored_quota');
  }
  await writeJsonDurable(join(base,'manifest.json'),manifest);await fault?.('journal');
  for(const m of moves){
   await m.source.check();await m.destination.check();
   const st=await lstat(m.source.path);if(st.ino!==m.inode||st.dev!==m.dev)throw new Error('workspace_ignored_path_changed');
   await rename(m.source.path,m.destination.path);m.moved=true;await fault?.('moved');
   await sync(dirname(m.source.path));await sync(dirname(m.destination.path));
   await m.source.check();await m.destination.check();
  }
  await fault?.('preserved');
  for(const path of manifest.retired_paths??[]){const p=await parent(files,path);try{await p.check();await validateDeclaredTree(p.path);}finally{await p.close();}}
  if((await preservationRoots(root,declarations)).length)throw new Error('workspace_uncaptured_ignored');
  return {rollback,async commit(){manifest={...manifest,state:'preserved',...(manifest.retired_paths?.length?{retired_at:new Date().toISOString()}:{} )};await writeJsonDurable(join(base,'manifest.json'),manifest);
   if(manifest.paths.length&&manifest.paths.every(p=>manifest.retired_paths?.includes(p))&&base.endsWith('-preserved-ignored')){
    const target=base.replace(/-preserved-ignored$/,'-retired-ignored');
    if(!await lstat(target).then(()=>true,e=>{if(missing(e))return false;throw e;})){await rename(base,target);await sync(locationDir);}
   }
   await rm(blocked,{force:true});await close();}};
 }catch(e){await rollback();
  // Admission failures remain discoverable without consuming active quota.
  if(String(e).includes('quota')||String(e).includes('scan_limit')||String(e).includes('sensitive_prefix')){await recordBlocked(e);}
  throw e;}
}
async function restoreManifest(base:string,m:Manifest,target=m.original_root){
 if(!Array.isArray(m.paths)||m.paths.some(p=>typeof p!=='string'||p.split('/').some(s=>!s||s==='.'||s==='..')))throw new Error('workspace_ignored_manifest_invalid');
 try{
  for(const path of [...m.paths].reverse()){
   const source=await parent(join(base,'files'),path),destination=await parent(target,path,true);
   try{
    if(!await lstat(source.path).catch(e=>{if(missing(e))return null;throw e;}))continue;
    await source.check();await destination.check();
    if(await lstat(destination.path).catch(e=>{if(missing(e))return null;throw e;}))throw new Error('workspace_ignored_restore_collision');
    await rename(source.path,destination.path);await sync(dirname(source.path));await sync(dirname(destination.path));
   }finally{await source.close();await destination.close();}
  }
  await writeJsonDurable(join(base,'manifest.json'),{...m,state:'rolled_back'});
  await rm(base,{recursive:true});await sync(dirname(base));
 }catch(e){await writeJsonDurable(join(base,'manifest.json'),{...m,state:'frozen'});throw e;}
}
/** Local Host owner governance; never remotely accepts arbitrary filesystem
 * paths. The key is copied from list. Destructive actions require an explicit
 * CLI acknowledgement. Rebuildable releases join the existing retired sweep. */
export async function governIgnored(config:string,location:string,action:string,key?:string,confirmed=false,destination?:string,page:{after?:string;limit?:number}={}){
 const release=action==='list'?()=>{}:await acquireIgnoredAdmission(config,location);
 try{return await governIgnoredHeld(config,location,action,key,confirmed,destination,page);}finally{release();}
}
async function governIgnoredHeld(config:string,location:string,action:string,key?:string,confirmed=false,destination?:string,page:{after?:string;limit?:number}={}){
 if(!SEGMENT.test(location)||key&&!SEGMENT.test(key))throw new Error('workspace_ignored_identity');
 const dir=join(config,'task-worktrees-quarantine',location);await realDir(config);await realDir(dirname(dir));await realDir(dir);
 if(action==='list'){
  const listed=key?{names:[`${key}-blocked-ignored.json`,`${key}-preserved-ignored`,`${key}-retired-ignored`],next:undefined}:await workspaceFilePage(dir,page.after,page.limit);
  const items:Record<string,unknown>[]=[],errors:Array<{name:string;error:string}>=[];
  for(const name of listed.names){try{
   if(key&&name!==`${key}-preserved-ignored`&&name!==`${key}-blocked-ignored.json`&&name!==`${key}-retired-ignored`)continue;
   if(name.endsWith('-blocked-ignored.json')){
    const h=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{
     const st=await h.stat();if(!st.isFile()||st.size>2*1024*1024)throw new Error('workspace_ignored_manifest_invalid');
     items.push({...JSON.parse(await h.readFile('utf8')),key:name.slice(0,-'-blocked-ignored.json'.length)});
    }finally{await h.close();}
   }else if(/-(?:preserved|retired)-ignored$/.test(name)){
    const m=await readManifest(join(dir,name));if(m)items.push({...m,key:name.replace(/-(?:preserved|retired)-ignored$/,'')});
   }
  }catch(e){if(missing(e))continue;errors.push({name,error:e instanceof SyntaxError?'invalid_json':e instanceof Error?e.message:'read_failed'});}}
  return {items,errors,next:listed.next??null};
 }
 if(!key)throw new Error('workspace key required');
 const base=await ignoredBase(dir,key);
 if(action==='discard'&&confirmed&&!await lstat(base).catch(e=>{if(missing(e))return null;throw e;})){await rm(join(dir,`${key}-blocked-ignored.json`),{force:true});await sync(dir);return {discarded:true};}
 await realDir(base);
 const m=await readManifest(base);
 const legacy=m&&key.startsWith(`${m.workspace_key}-`)&&/^[0-9a-f-]{36}$/.test(key.slice(m.workspace_key.length+1));
 if(!m||m.location_id!==location||m.workspace_key!==key&&!legacy)throw new Error('workspace_ignored_identity');
 // CLI holds the same cross-process lock as the daemon for every mutation.
 if(m.state==='preserving')throw new Error('interrupted transaction: resume Host cleanup first');
 if(action==='restore'){const target=destination??m.original_root;await realDir(target);await restoreManifest(base,m,target);return {restored:true};}
 if(!confirmed)throw new Error('explicit --confirm-discard or --confirm-rebuildable required');
 if(action==='discard'){await rm(base,{recursive:true});await sync(dir);return {discarded:true};}
 if(action==='rebuildable'){
  if(m.state!=='preserved')throw new Error('only a completed snapshot can expire');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  // The legacy retention matcher requires an eight-hex nonce, not a UUID.
  const target=join(dir,`${key}-${stamp}-00000000-retired`);
  await writeJsonDurable(join(base,'manifest.json'),{...m,retention:'owner_confirmed_rebuildable',declared_at:new Date().toISOString()});
  await rename(base,target);await sync(dir);return {expires_after_days:30};
 }
 throw new Error('usage: ignored <list|restore|discard|rebuildable> --location <location> [--key <key>]');
}

/** An interrupted or committed preservation cannot be used as a live tree.
 * Cleanup replay or offline owner restore must resolve the journal first. */
export async function assertIgnoredWorkspaceAvailable(config:string,location:string,key:string){
 const m=await readManifest(await ignoredBase(join(config,'task-worktrees-quarantine',location),key));
 if(m&&m.state!=='rolled_back')throw new Error('workspace_ignored_owner_review');
}

/** Restore only after Git has re-created the same physical worktree. */
export async function resumeIgnoredWorkspace(config:string,location:string,key:string,root:string){
 const release=await acquireIgnoredAdmission(config,location);
 try{return await resumeIgnoredHeld(config,location,key,root);}finally{release();}
}
async function resumeIgnoredHeld(config:string,location:string,key:string,root:string){
 const base=await ignoredBase(join(config,'task-worktrees-quarantine',location),key);
 await realDir(config);for(const dir of [join(config,'task-worktrees-quarantine'),join(config,'task-worktrees-quarantine',location)]){try{await realDir(dir);}catch(e){if(missing(e))return;throw e;}}
 const m=await readManifest(base);if(!m)return;
 if(m.location_id!==location||m.workspace_key!==key||m.original_root!==root)throw new Error('workspace_ignored_identity');
 if(m.state==='frozen')throw new Error('workspace_ignored_owner_review');
 if(m.state!=='rolled_back')await restoreManifest(base,m);
 else {await rm(base,{recursive:true});await sync(dirname(base));}
}
const within=(path:string,prefix:string)=>path===prefix||path.startsWith(prefix+'/');
function validPrefix(path:string){
 if(looksSecretLikePath(path)||!path||path.length>1024||path.includes('\\')||path.split('/').some(s=>!s||s==='.'||s==='..'||s.startsWith('.')||/^(?:credentials?|secrets?|id_rsa|id_ed25519)$/i.test(s)))throw new Error('workspace_ignored_sensitive_prefix');
}
async function readDeclarations(config:string,location:string):Promise<string[]>{
 const path=join(config,'ignored-rebuildable',location+'.json');
 try{const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{
  const value=JSON.parse(await h.readFile('utf8'));if(!Array.isArray(value)||value.length>128)throw new Error('invalid declarations');
  value.forEach(validPrefix);return value;
 }finally{await h.close();}}catch(e){if(missing(e))return [];throw e;}
}
/** Owner supplies an exact relative directory prefix; names never imply consent.
 * Ancestors and the root must be real directories, and sensitive descendants
 * are refused even inside an otherwise declared generated directory. */
export async function declareIgnoredRoot(config:string,location:string,root:string,prefix:string,confirmed:boolean){
 if(!confirmed)throw new Error('explicit --confirm-rebuildable required');
 if(!SEGMENT.test(location))throw new Error('workspace_ignored_identity');validPrefix(prefix);
 const p=await parent(root,prefix);try{await p.check();const h=await directory(p.path);await h.close();await validateDeclaredTree(p.path);}finally{await p.close();}
 const dir=join(config,'ignored-rebuildable');await realDir(config);await realDir(dir,true);
 const values=await readDeclarations(config,location);if(!values.includes(prefix))values.push(prefix);
 if(values.length>128)throw new Error('workspace_ignored_quota');
 await writeJsonDurable(join(dir,location+'.json'),values);return {prefix,continuous:true,expires_after_days:30};
}
async function validateDeclaredTree(path:string,depth=0,budget={remaining:100000}){
 if(depth>64||--budget.remaining<0)throw new Error('workspace_ignored_scan_limit');
 const st=await lstat(path);if(st.isSymbolicLink())throw new Error('workspace_ignored_sensitive_prefix');
 if(st.isFile()){const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const current=await h.stat();if(current.ino!==st.ino||current.dev!==st.dev)throw new Error('workspace_ignored_path_changed');await h.sync();}finally{await h.close();}return;}
 if(!st.isDirectory())throw new Error('workspace_ignored_sensitive_prefix');
 const h=await directory(path);try{for await(const e of await opendir(fdPath(h))){
  if(looksSecretLikePath(e.name)||e.name.startsWith('.')||/^(?:credentials?|secrets?|id_rsa|id_ed25519)$/i.test(e.name))throw new Error('workspace_ignored_sensitive_prefix');
  await validateDeclaredTree(join(fdPath(h),e.name),depth+1,budget);
 }await h.sync();}finally{await h.close();}
}
async function splitDeclaredRoots(root:string,paths:string[],prefixes:string[]):Promise<string[]>{
 const result:string[]=[];
 const visit=async(path:string)=>{
  if(result.length>=2000)throw new Error('workspace_uncaptured_ignored');
  if(prefixes.some(p=>within(p,path)&&p!==path)){
   const p=await parent(root,path);try{const h=await directory(p.path);try{for await(const e of await opendir(fdPath(h)))await visit(path+'/'+e.name);}finally{await h.close();}}finally{await p.close();}
  }else result.push(path);
 };
 for(const path of paths)await visit(path);return result;
}
/** Called by the existing retired-quarantine sweep. Only the exact roots
 * explicitly authorized at capture expire; unknown siblings never do. */
function validateRetiredManifest(m:Manifest,location:string,name:string){
 const safePath=(p:unknown):p is string=>typeof p==='string'&&p.length>0&&p.length<=1024&&!p.includes('\\')&&!p.split('/').some(s=>!s||s==='.'||s==='..');
 if(m.version!==2||m.location_id!==location||!SEGMENT.test(m.workspace_key)||!['-preserved-ignored','-retired-ignored'].some(suffix=>name===m.workspace_key+suffix)||m.retention!=='owner_review'
  ||!Array.isArray(m.paths)||m.paths.length>2000||!m.paths.every(safePath)||new Set(m.paths).size!==m.paths.length
  ||!Array.isArray(m.retired_paths)||!m.retired_paths.every(p=>safePath(p)&&m.paths.includes(p))
  ||m.paths.some((p,i)=>m.paths.some((other,j)=>i!==j&&within(p,other))))throw new Error('workspace_ignored_manifest_invalid');
 // Validate the entire grant before the first side effect. A malformed later
 // path must never turn a partly valid manifest into deletion authority.
 m.retired_paths.forEach(validPrefix);
}
export async function sweepRetiredIgnored(config:string,location:string,now:number,log:(line:string)=>void=()=>{}){
 const release=await acquireIgnoredAdmission(config,location);
 try{return await sweepRetiredIgnoredHeld(config,location,now,log);}finally{release();}
}
async function sweepRetiredIgnoredHeld(config:string,location:string,now:number,log:(line:string)=>void){
 const dir=join(config,'task-worktrees-quarantine',location);
 return sweepWorkspaceFilePage(dir,'ignored-'+location,async name=>{
  if(!/-(?:preserved|retired)-ignored$/.test(name))return;
  const e={name};
  try{
   const base=join(dir,e.name),m=await readManifest(base);
   if(!m||m.state!=='preserved'||!m.retired_paths?.length)return;
   validateRetiredManifest(m,location,e.name);
   const retiredAt=Date.parse(m.retired_at??'');
   if(!Number.isFinite(retiredAt))throw new Error('workspace_ignored_manifest_invalid');
   if(now-retiredAt<30*86400_000)return;
   const removed=new Set<string>();
   for(const path of m.retired_paths){
    try{
     const p=await parent(join(base,'files'),path);
     try{await p.check();await rm(p.path,{recursive:true,force:true});await sync(dirname(p.path));}finally{await p.close();}
     removed.add(path);
    }catch(error){
     // A crash may have removed the root before recording progress. Ancestor
     // absence also proves this authorized root absent; other errors retain it.
     if(missing(error))removed.add(path);
     else log(`ignored quarantine ${location}/${e.name}: retired root retained (${(error as NodeJS.ErrnoException).code??'validation_failed'})`);
    }
   }
   if(!removed.size)return;
   const paths=m.paths.filter(p=>!removed.has(p));
   const next={...m,paths,retired_paths:m.retired_paths.filter(p=>!removed.has(p))};
   await writeJsonDurable(join(base,'manifest.json'),next);
   // Remove empty ancestors only. Never recursively remove a snapshot shell:
   // unknown siblings, even absent from the manifest, are owner assets.
   for(const path of removed){
    const parts=path.split('/');parts.pop();
    while(parts.length){await rmdir(join(base,'files',...parts)).catch(()=>{});parts.pop();}
   }
   if(!paths.length){
    await rmdir(join(base,'files')).catch(error=>{if(!missing(error))throw error;});
    const entries=[];for await(const entry of await opendir(base)){entries.push(entry.name);if(entries.length>1)break;}
    if(entries.length!==1||entries[0]!=='manifest.json')throw new Error('workspace_ignored_unknown_content');
    await rm(join(base,'manifest.json'));await rmdir(base);await sync(dir);
   }
  }catch(error){log(`ignored quarantine ${location}/${e.name}: retained (${error instanceof SyntaxError?'invalid_json':error instanceof Error?error.message:'read_failed'})`);}
 },log,256,config,8);
}


async function ignoredBase(dir:string,key:string){
 const active=join(dir,key+'-preserved-ignored'),retired=join(dir,key+'-retired-ignored');
 const exists=async(path:string)=>lstat(path).then(()=>true,e=>{if(missing(e))return false;throw e;});
 const a=await exists(active),r=await exists(retired);
 if(a&&r)throw new Error('workspace_ignored_identity_ambiguous');
 return r?retired:active;
}
