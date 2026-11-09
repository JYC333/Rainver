import {readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ExecutionWorkspaceRef} from '@rainver/protocol';
import {runLocationGit} from '@rainver/folder-read';
import {configDir} from './config.js';
import {commitOfRef} from './mainBranch.js';
import {isAncestor,readJson} from './taskWorktree.js';
import {syncExistingDurable,writeJsonDurable} from './durableFile.js';
import {readRef,RefReadError,syncRefDurable} from './durableRef.js';
import {cleanupNativeWorkspaceReceipts} from './workspaceNativeCleanup.js';
import {workspaceDeltaAlreadyApplied} from './appliedWorkspaceDelta.js';
import {versionPresence} from './workspaceFileRead.js';

/**
 * Bounded retention for one isolated workspace generation's Git metadata.
 * The server decides from durable merge facts which branch/refs are no longer
 * needed; the Host re-proves the branch against Git and deletes only exact,
 * attributable refs by expected-oid CAS. Nothing here runs `git gc`, prunes
 * objects or rewrites a reflog: unreachable objects are left to Git's own
 * maintenance under its normal expiry.
 */
const COMMIT=/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OWNED_REFS=200,MAX_LISTED_REFS=500,MAX_HISTORY_REFS=1000;

function materializationPath(locationId:string,key:string){return join(configDir(),'workspace-materializations',locationId,`${key}.json`);}
/** The durable outcome of one completed branch release, replayed to any re-delivery of that same release. */
export interface ReleaseRecord {epoch:number;id:string;generation:number;expected_commit:string|null;
 /** Stable digest of the whole request (see `releaseRequestDigest`); absent only in records written before it existed. */
 request?:string;
 /** 2 for a v2 `request`; absent for a v1 digest (see `sameRequest`), bound to v2 by the first replay (`completedRelease`). */
 digest_version?:number;history_refs:string[];retained_refs:Array<{ref:string;reason:string}>;inventory:Record<string,unknown>}
async function materializationRecord(locationId:string,key:string):Promise<{epoch:number;admitted?:number;release?:ReleaseRecord}>{
 const raw=await readJson(materializationPath(locationId,key));
 const epoch=Number(raw?.epoch??0),admitted=Number(raw?.admitted);
 const release=raw?.release&&typeof raw.release==='object'?raw.release as ReleaseRecord:undefined;
 return {epoch:Number.isSafeInteger(epoch)&&epoch>=0?epoch:0,...(Number.isSafeInteger(admitted)?{admitted}:{}),...(release?{release}:{})};
}
/**
 * The Host's fence for one owner key: the newest epoch a launch was admitted
 * with (or the epoch after the last completed release). 0 when never reclaimed.
 * Read and written only under the Task lease (launch prepare or cleanup).
 */
export async function recordedMaterializationEpoch(locationId:string,key:string):Promise<number>{
 return (await materializationRecord(locationId,key)).epoch;
}
/**
 * After a release of epoch N, only launches admitted after the server's bump
 * (N+1) may rebuild. The fence and the release's result are one atomic file
 * write, so a crash can never leave the fence raised without the result a
 * re-delivery of the same release must replay.
 */
export async function recordReleasedMaterialization(locationId:string,key:string,released:number,result:Omit<ReleaseRecord,'epoch'>){
 const next=Math.max(await recordedMaterializationEpoch(locationId,key),released+1);
 await writeJsonDurable(materializationPath(locationId,key),{epoch:next,released_at:new Date().toISOString(),release:{...result,epoch:released,inventory:{...result.inventory,materialization_epoch:next}}});
}
/**
 * The completed release of this identity and epoch. The server sends one
 * release per epoch and re-sends exactly that request (crash retry, a fresh
 * operation id), so only the same request digest replays. Different content
 * under the same identity and epoch is a conflict, never a replay that would
 * skip the new work. A record from before the digest existed was written by
 * the only request of its epoch and still replays.
 */
export async function completedRelease(locationId:string,key:string,ref:ExecutionWorkspaceRef,epoch:number,expected:string|null,request:RequestDigest):Promise<ReleaseRecord|'conflict'|null>{
 const path=materializationPath(locationId,key);
 const release=(await materializationRecord(locationId,key)).release;
 if(!release||release.epoch!==epoch||release.id!==ref.id||release.generation!==ref.generation)return null;
 if((release.expected_commit??null)!==expected||release.request!==undefined&&!sameRequest(release,request,'request'))return 'conflict';
 // A replay acknowledges this record: it must be on disk, not only in the page cache.
 if(release.digest_version===DIGEST_VERSION){await syncExistingDurable(path);return release;}
 // A v1 (or pre-digest) record cannot tell fields it never covered (kept_epoch,
 // integration) apart. The first request accepted for it binds it to that
 // request's full v2 digest in one atomic write of the whole record (fence and
 // admission unchanged), itself the barrier: from then on only that exact
 // content replays it, under any operation id.
 const bound={...release,request:request.current,digest_version:DIGEST_VERSION};
 await writeJsonDurable(path,{...await readJson(path),release:bound});
 return bound;
}
/**
 * A stable digest of everything a cleanup request asks for: identity, fence,
 * target, proof inputs, history and the exact ref list. Order and duplicates
 * do not change it; any changed content does.
 */
export interface ReleaseRequest {id:string;generation:number;locationId:string;integrationId?:string|null;expected?:string|null;retain:boolean;epoch?:number;target?:string|null;history?:readonly string[];proof?:readonly string[];bases?:readonly string[];refs?:readonly RefRelease[]}
export function releaseRequestDigest(input:ReleaseRequest){
 const set=(v:readonly string[]|undefined)=>[...new Set(v??[])].sort();
 // v2 adds every remaining field that changes execution: each ref's kept_epoch and the integration identity.
 const refs=[...new Set((input.refs??[]).map(r=>JSON.stringify([r.ref,r.expected_commit??null,Boolean(r.prefix),r.kept_epoch??null])))].sort();
 return createHash('sha256').update(JSON.stringify({v:2,id:input.id,generation:input.generation,location:input.locationId,integration:input.integrationId??null,expected:input.expected??null,retain:input.retain,epoch:input.epoch??null,
  target:input.target??null,history:set(input.history),proof:set(input.proof),bases:set(input.bases),refs})).digest('hex');
}
/** The v1 digest records written before v2 carry (no `digest_version`); used only to recognise them. */
export function legacyReleaseRequestDigest(input:ReleaseRequest){
 const set=(v:readonly string[]|undefined)=>[...new Set(v??[])].sort();
 const refs=[...new Map((input.refs??[]).map(r=>[JSON.stringify([r.ref,r.expected_commit??null,Boolean(r.prefix)]),1])).keys()].sort();
 return createHash('sha256').update(JSON.stringify({v:1,id:input.id,generation:input.generation,location:input.locationId,expected:input.expected??null,retain:input.retain,epoch:input.epoch??null,
  target:input.target??null,history:set(input.history),proof:set(input.proof),bases:set(input.bases),refs})).digest('hex');
}
/**
 * The current digest and how a stored record is recognised as this same
 * request. A record from before v2 matches by its v1 digest, so a crash-retried
 * release, a later page or a legacy settle continues after the upgrade; every
 * record written from now on carries `digest_version: 2` and only v2 matches it.
 * Any other stored digest under the same id is different content: refused.
 */
export interface RequestDigest {current:string;legacy:string}
export const DIGEST_VERSION=2;
export function sameRequest(record:{fingerprint?:unknown;request?:unknown;digest_version?:unknown}|null|undefined,digest:RequestDigest,field:'fingerprint'|'request'='fingerprint'){
 const stored=record?.[field];
 if(typeof stored!=='string')return false;
 return record?.digest_version===DIGEST_VERSION?stored===digest.current:stored===digest.current||stored===digest.legacy;
}
/** A launch was admitted after release `epoch` finished: owned-by-name refs may now be the rebuild's. */
export async function rebuiltSinceRelease(locationId:string,key:string,epoch:number):Promise<boolean>{
 const record=await materializationRecord(locationId,key);
 return record.epoch>epoch+1||(record.admitted??-1)>epoch;
}
/** Record the newest admitted launch epoch; a launch from an older one is stale. Caller holds the Task lease. */
export async function admitMaterialization(locationId:string,key:string,ref:ExecutionWorkspaceRef){
 if(ref.materialization_epoch===undefined)return;
 const record=await materializationRecord(locationId,key);
 if(ref.materialization_epoch<record.epoch)throw new Error('workspace_materialization_stale');
 // The admission is recorded even at the current epoch: a later page of the
 // previous release must know the owned names may now be this rebuild's.
 if(ref.materialization_epoch>record.epoch||record.admitted!==ref.materialization_epoch)
  await writeJsonDurable(materializationPath(locationId,key),{...record,epoch:Math.max(record.epoch,ref.materialization_epoch),admitted:ref.materialization_epoch});
 // The same admission is already visible, but an earlier write of it may have
 // failed after its rename: an equal value is made durable, never trusted.
 else await syncExistingDurable(materializationPath(locationId,key));
}

/**
 * A branch tip may be released only when its exact content is already part of
 * the target: the tip itself is target history, its tree equals a recorded
 * merge commit that is target history, or its whole delta from a common base
 * (the Host's own merge-base, or a recorded batch base that is history of both)
 * reverse-applies to the actual target tree. The last case covers the same
 * change applied by another commit while the target also moved on. Every check
 * runs against local Git; server inputs only nominate candidates.
 */
export async function verifyBranchReclaim(repoRoot:string,tip:string,targetRef:string|undefined,proofs:readonly string[],bases:readonly string[]=[]):Promise<string|null>{
 if(!targetRef)return 'workspace_reclaim_target_unavailable';
 const target=await commitOfRef(repoRoot,targetRef);
 if(!target)return 'workspace_reclaim_target_unavailable';
 if(await isAncestor(repoRoot,tip,target))return null;
 const tipTree=await treeOf(repoRoot,tip);
 if(!tipTree)return 'workspace_reclaim_unproven';
 for(const proof of proofs){
  if(!COMMIT.test(proof))continue;
  if(await treeOf(repoRoot,proof)===tipTree&&await isAncestor(repoRoot,proof,target))return null;
 }
 const common=await runLocationGit(['merge-base',tip,target],repoRoot);
 const candidates=[...new Set([...(common.code===0?[common.stdout.trim()]:[]),...bases.filter(b=>COMMIT.test(b))])].slice(0,20);
 for(const base of candidates){
  // A base outside either history would hide part of the tip's content from the delta.
  if(!COMMIT.test(base)||base===tip||!await isAncestor(repoRoot,base,tip)||!await isAncestor(repoRoot,base,target))continue;
  if(await workspaceDeltaAlreadyApplied(repoRoot,base,tip,target))return null;
 }
 return 'workspace_reclaim_unproven';
}
async function treeOf(repoRoot:string,commit:string):Promise<string|null>{
 const out=await runLocationGit(['rev-parse','--verify','--quiet',`${commit}^{tree}`],repoRoot);
 return out.code===0?out.stdout.trim():null;
}

/** Names the Host will delete on request. Anything else is refused, never guessed. */
export function releasableRef(name:string,ref:ExecutionWorkspaceRef,prefix=false):boolean{
 const parts=name.split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'))return false;
 if(prefix)return parts.length===4&&parts[2]==='local-preimages'&&COMMIT.test(parts[3]!);
 if(parts[2]==='recovery'&&parts.length===5)return parts[3]===ref.id&&COMMIT.test(parts[4]!);
 if(parts[2]==='recovery'&&parts.length===4)return UUID.test(parts[3]!);
 if(parts[2]==='native-preimages'&&parts.length===6)return parts[3]===ref.id&&parts[4]===`g${ref.generation}`&&UUID.test(parts[5]!);
 if(parts[2]==='run-history'&&parts.length===6)return parts[3]===ref.id&&parts[4]===`g${ref.generation}`&&COMMIT.test(parts[5]!);
 if(parts[2]==='sources'&&parts.length===4)return COMMIT.test(parts[3]!);
 if(parts[2]==='local-preimages'&&parts.length===4)return /^[0-9a-f]{40}(?:[0-9a-f]{24})?(?:-index)?$/.test(parts[3]!);
 return false;
}

export interface RefRelease {ref:string;expected_commit?:string;prefix?:boolean;kept_epoch?:number}
function prefixMembers(prefix:string){return [prefix,`${prefix}-index`];}
/**
 * Delete each attributable ref by CAS on its current oid. Missing refs are done.
 * A Run-history ref carrying `kept_epoch` is deleted only if no newer release
 * (re)kept it (`keepers`, read under the same Task lease that keeps them), so
 * an older expiry never removes a renewed ref.
 */
export async function releaseRefs(repoRoot:string,ref:ExecutionWorkspaceRef,list:readonly RefRelease[],options:{rebuilt?:boolean;keepers?:Readonly<Record<string,number>>;sourceFence?:boolean}={}):Promise<Array<{ref:string;reason:string}>>{
 const retained:Array<{ref:string;reason:string}>=[];
 const ownedByName=[`refs/rainver/recovery/${ref.id}/`,`refs/rainver/native-preimages/${ref.id}/`];
 const historyPrefix=`refs/rainver/run-history/${ref.id}/g${ref.generation}/`;
 for(const item of list){
  if(!item.ref.startsWith('refs/rainver/')||!releasableRef(item.ref,ref,item.prefix)){retained.push({ref:item.ref,reason:'ref_release_refused'});continue;}
  // A shared source is deleted only by a request the server claimed under its
  // fence: a late copy of an older, unfenced request (or any branch release)
  // deletes none, whatever its content.
  if(item.ref.startsWith('refs/rainver/sources/')&&!options.sourceFence){retained.push({ref:item.ref,reason:'ref_release_unfenced'});continue;}
  // After a rebuild, names attributable only by workspace id may be the new
  // materialization's: an older release keeps them for the next release to judge.
  if(options.rebuilt&&ownedByName.some(p=>item.ref.startsWith(p))){retained.push({ref:item.ref,reason:'ref_owner_rebuilt'});continue;}
  if(item.kept_epoch!==undefined&&item.ref.startsWith(historyPrefix)&&(options.keepers?.[item.ref.slice(historyPrefix.length)]??-1)>item.kept_epoch){retained.push({ref:item.ref,reason:'ref_renewed'});continue;}
  let names=[item.ref];
  if(item.prefix){
   // The family is exactly its releasable members (`<commit>`, `<commit>-index`).
   // A glob listing could be filled by unrelated names sorting first and cut
   // the real members off; those unrelated refs are not this release's.
   const members=await Promise.all(prefixMembers(item.ref).map(async name=>({name,oid:await readRef(repoRoot,name).catch(()=>undefined)})));
   // A member that could not be read is unfinished, never taken as already gone.
   if(members.some(m=>m.oid===undefined)){retained.push({ref:item.ref,reason:'ref_release_failed'});continue;}
   const listed=members.filter(m=>m.oid).map(m=>m.name);
   // Never silently cut: an unfinished family is reported, and the caller continues it.
   if(listed.length>MAX_OWNED_REFS)retained.push({ref:item.ref,reason:'ref_release_truncated'});
   names=listed.slice(0,MAX_OWNED_REFS);
  }
  for(const name of names){
   if(!releasableRef(name,ref)){retained.push({ref:name,reason:'ref_release_refused'});continue;}
   const oid=await readRef(repoRoot,name).catch(()=>undefined);
   if(oid===undefined){retained.push({ref:name,reason:'ref_release_failed'});continue;}
   if(!oid)continue;
   // A content-addressed source ref must still name its own commit.
   const expected=item.expected_commit??(name.startsWith('refs/rainver/sources/')?name.slice('refs/rainver/sources/'.length):undefined);
   if(expected&&oid!==expected){retained.push({ref:name,reason:'ref_moved'});continue;}
   const deleted=await runLocationGit(['update-ref','-m','rainver: release workspace recovery ref','-d',name,oid],repoRoot);
   if(deleted.code!==0&&await readRef(repoRoot,name).catch(()=>'unreadable')!==null)retained.push({ref:name,reason:'ref_release_failed'});
  }
 }
 return retained;
}

const MAX_REF_LINE=4096;
/**
 * Sorted refs matching `patterns`, strictly after `after`; at most limit+1 so
 * callers see a further page. Git 2.43 has no `--start-after` (2.51), so the
 * sorted output is streamed: names up to the cursor are skipped without being
 * kept, and Git is stopped as soon as limit+1 names were read, so neither the
 * memory nor an output budget grows with the number of refs. Names compare as
 * bytes, Git's own `refname` order; output out of that order, an overlong
 * line or any failed run throws instead of returning a page that could skip,
 * repeat or loop.
 */
async function listRefs(repoRoot:string,patterns:string[],limit:number,after?:string){
 const cursor=after!==undefined?Buffer.from(after,'utf8'):null;
 const refs:Array<{ref:string;commit:string}>=[];
 let pending:Buffer=Buffer.alloc(0),previous:Buffer|null=null,fault:string|null=null;
 const take=(line:Buffer)=>{
  if(!line.length)return true;
  const space=line.indexOf(0x20);
  const name=space>0?line.subarray(0,space):line;
  if(previous&&Buffer.compare(name,previous)<=0){fault='unsorted';return false;}
  previous=Buffer.from(name);
  if(cursor&&Buffer.compare(name,cursor)<=0)return true;
  const commit=space>0?line.subarray(space+1).toString('utf8'):'';
  if(!COMMIT.test(commit))return true;
  refs.push({ref:name.toString('utf8'),commit});
  return refs.length<=limit;
 };
 const consume=(chunk:Buffer)=>{
  pending=pending.length?Buffer.concat([pending,chunk]):chunk;
  for(let end=pending.indexOf(0x0a);end>=0;end=pending.indexOf(0x0a)){
   const line=pending.subarray(0,end);pending=pending.subarray(end+1);
   if(!take(line))return false;
  }
  if(pending.length>MAX_REF_LINE){fault='line too long';return false;}
  return true;
 };
 const out=await runLocationGit(['for-each-ref','--sort=refname','--format=%(refname) %(objectname)',...patterns],repoRoot,30_000,{onStdout:consume});
 if(fault||!out.stopped&&(out.code!==0||out.incomplete||out.stderr.trim()))throw new Error('workspace_ref_inventory_failed');
 if(!out.stopped&&pending.length&&take(pending)===false&&fault)throw new Error('workspace_ref_inventory_failed');
 return refs.slice(0,limit+1);
}
/**
 * Refs attributable to this workspace by name (its recovery and native
 * preimages), one sorted page after `after`. `owned_refs_next` is the cursor
 * of the next page; null means this page is the last.
 */
export async function ownedWorkspaceRefs(repoRoot:string,ref:ExecutionWorkspaceRef,after?:string){
 const refs=await listRefs(repoRoot,[`refs/rainver/recovery/${ref.id}/`,`refs/rainver/native-preimages/${ref.id}/g${ref.generation}/`],MAX_OWNED_REFS,after);
 const more=refs.length>MAX_OWNED_REFS,page=refs.slice(0,MAX_OWNED_REFS);
 return {owned_refs:page,owned_refs_truncated:more,owned_refs_next:more?page.at(-1)!.ref:null};
}
/** Location-wide bounded inventory so the server can attribute or explicitly retain legacy refs. */
export async function listRainverRefs(repoRoot:string,after?:string){
 const page=await listRefs(repoRoot,['refs/rainver/'],MAX_LISTED_REFS,after);
 return {refs:page.slice(0,MAX_LISTED_REFS),next:page.length>MAX_LISTED_REFS?page[MAX_LISTED_REFS-1]!.ref:null};
}

/**
 * The run-history refs this generation actually has in Git (commits, by exact
 * name and oid), so a partial or failed history step still reports every ref
 * it already created and none is left without an expiry.
 */
export async function runHistoryRefs(repoRoot:string,ref:ExecutionWorkspaceRef,after?:string):Promise<{commits:string[];next:string|null}>{
 const prefix=`refs/rainver/run-history/${ref.id}/g${ref.generation}/`;
 // Sorted pages of at most MAX_HISTORY_REFS names after the cursor; the caller
 // continues from `next` until it is null, so no ref is left without an expiry.
 const refs=await listRefs(repoRoot,[prefix],MAX_HISTORY_REFS,after&&COMMIT.test(after)?prefix+after:undefined);
 const page=refs.slice(0,MAX_HISTORY_REFS);
 const commits=page.filter(r=>r.ref===prefix+r.commit).map(r=>r.commit);
 return {commits,next:refs.length>MAX_HISTORY_REFS?page.at(-1)!.ref.slice(prefix.length):null};
}

function keepersPath(locationId:string,key:string){return join(configDir(),'workspace-history-keepers',locationId,`${key}.json`);}
/** The newest release epoch that (re)kept each Run-history commit of this identity. Read and written under the Task lease. */
export async function historyKeepers(locationId:string,key:string):Promise<Record<string,number>>{
 const raw=await readJson(keepersPath(locationId,key));
 const out:Record<string,number>={};
 const commits=raw?.commits&&typeof raw.commits==='object'?raw.commits as Record<string,unknown>:{};
 for(const [c,e] of Object.entries(commits))if(COMMIT.test(c)&&Number.isSafeInteger(e)&&(e as number)>=0)out[c]=e as number;
 return out;
}
/**
 * Record, before any history ref is (re)created, that release `epoch` keeps
 * these commits. It is the version an older expiry is checked against, so the
 * renewal is durable before the ref it protects exists. Never removed with
 * receipts: it outlives the release like the epoch record.
 */
export async function recordHistoryKeepers(locationId:string,key:string,commits:readonly string[],epoch:number){
 const current=await historyKeepers(locationId,key);
 let changed=false;
 for(const c of commits)if(COMMIT.test(c)&&(current[c]??-1)<epoch){current[c]=epoch;changed=true;}
 // Unchanged epochs may come from an earlier write whose sync failed: still a barrier.
 if(changed)await writeJsonDurable(keepersPath(locationId,key),{commits:current});
 else await syncExistingDurable(keepersPath(locationId,key));
}

/**
 * Re-create shared `refs/rainver/sources/<c>` after a confirmed deletion whose
 * commit gained a dependent meanwhile. Only a missing ref is created (CAS on
 * absence) and only while the commit object is present; the result lists the
 * commits whose ref exists afterwards. A write failure while the object is
 * present throws (`SourceRefWriteError`): it is retried, never read as missing.
 */
export async function pinSources(repoRoot:string,commits:readonly string[]):Promise<string[]>{
 const pinned:string[]=[];
 for(const commit of new Set(commits)){
  if(!COMMIT.test(commit))continue;
  if(await createProtectingRef(repoRoot,`refs/rainver/sources/${commit}`,commit,'rainver: re-pin frozen workspace source')==='created')pinned.push(commit);
 }
 return pinned;
}

/**
 * A protecting ref (keeper or re-pinned shared name) could not be written while
 * its commit object is present: a ref lock held by another writer, an I/O or
 * permission failure. Retryable, and never reported as a lost source: the
 * operation throws before any later step (settle, restore, deletion) and its
 * journal stays unfinished, so the same operation id runs again in full.
 */
export class SourceRefWriteError extends Error{
 constructor(readonly ref:string,detail:string){super('workspace_source_ref_write_failed');this.cause=detail;}
}
const REF_WRITE_ATTEMPTS=4;
/**
 * Create `name` → `commit` by CAS on absence and prove it from Git afterwards.
 * `created`: the ref holds the commit (now or already). `occupied`: it holds
 * another oid (never overwritten). `missing`: the commit object is gone (a
 * definite loss, not a write failure). Anything else is retried briefly
 * (short ref-lock contention), then thrown as `SourceRefWriteError`.
 * The ref update asks Git to fsync it (`core.fsync=reference`, Git >= 2.36).
 */
export async function createProtectingRef(repoRoot:string,name:string,commit:string,reason:string):Promise<'created'|'occupied'|'missing'>{
 let detail='';
 for(let attempt=0;attempt<REF_WRITE_ATTEMPTS;attempt++){
  try{
   const current=await readRef(repoRoot,name);
   if(current&&current!==commit)return 'occupied';
   // Only Git's clean `missing` answer is a loss; an unreadable object store is a retryable failure.
   const presence=await versionPresence(repoRoot,commit);
   if(presence==='missing'||presence==='other')return 'missing';
   if(presence==='failed')detail='object store unreadable';
   else{
    if(!current){
     const created=await runLocationGit(['-c','core.fsync=reference','update-ref','-m',reason,name,commit,''],repoRoot);
     detail=created.stderr.trim().slice(0,200);
    }
    // Present already (an earlier attempt, an older Host) or just written: the
    // same oid is never trusted as durable. Its storage is synced before the
    // ref is reported or anything is deleted on its strength.
    if(await readRef(repoRoot,name)===commit){await syncRefDurable(repoRoot,name,commit);return 'created';}
   }
  }catch(error){
   if(!(error instanceof RefReadError))throw error;
   detail=`${error.message}: ${String(error.cause??'')}`.slice(0,200);
  }
  if(attempt+1<REF_WRITE_ATTEMPTS)await new Promise(resolve=>setTimeout(resolve,50*2**attempt));
 }
 throw new SourceRefWriteError(name,detail);
}

/**
 * The independent keeper of a shared source commit: one per workspace
 * generation and commit, outside every releasable namespace (`releasableRef`
 * never accepts `source-keepers`, in any Host version), so no release list —
 * an earlier, a late or a cancelled one — can delete it. It is the
 * server-recorded responsibility of that generation's ref work (`keepers`),
 * removed only once the shared name holds the commit again.
 */
export function sourceKeeperRef(ref:ExecutionWorkspaceRef,commit:string){return `refs/rainver/source-keepers/${ref.id}/g${ref.generation}/${commit}`;}
/**
 * Keep each present commit under its keeper ref (CAS on absence, verified from
 * Git). A missing object gets none (reported by `keptSources`); a write that
 * fails while the object is present throws `SourceRefWriteError`, so nothing
 * after it in the operation runs.
 */
export async function keepSources(repoRoot:string,ref:ExecutionWorkspaceRef,commits:readonly string[]){
 for(const commit of new Set(commits)){
  if(!COMMIT.test(commit))continue;
  const name=sourceKeeperRef(ref,commit);
  // An occupied keeper name holds another oid: not this commit's protection.
  if(await createProtectingRef(repoRoot,name,commit,'rainver: keep frozen workspace source')==='occupied')throw new SourceRefWriteError(name,'keeper ref holds another commit');
 }
}
/** Drop keepers whose shared `sources` ref holds the commit again; the others stay. */
export async function releaseSourceKeepers(repoRoot:string,ref:ExecutionWorkspaceRef,commits:readonly string[]){
 for(const commit of new Set(commits)){
  const shared=`refs/rainver/sources/${commit}`;
  if(!COMMIT.test(commit))continue;
  try{
   if(await readRef(repoRoot,shared)!==commit)continue;
   // The shared name replaces the keeper only once it is itself durable (it may
   // predate this Host version or an earlier attempt's failed sync).
   await syncRefDurable(repoRoot,shared,commit);
   const name=sourceKeeperRef(ref,commit);
   const oid=await readRef(repoRoot,name);
   if(oid)await runLocationGit(['update-ref','-m','rainver: shared source restored','-d',name,oid],repoRoot);
  }catch(error){
   if(error instanceof RefReadError)throw new SourceRefWriteError(shared,String(error.cause??error.message));
   throw error;
  }
 }
}
/** Of `commits`, those whose keeper ref exists now. A failed read throws (retryable), never "not kept". */
export async function keptSources(repoRoot:string,ref:ExecutionWorkspaceRef,commits:readonly string[]){
 const kept:string[]=[];
 for(const commit of new Set(commits)){
  if(!COMMIT.test(commit))continue;
  const name=sourceKeeperRef(ref,commit);
  const oid=await readRef(repoRoot,name).catch((error:unknown)=>{throw error instanceof RefReadError?new SourceRefWriteError(name,String(error.cause??error.message)):error;});
  if(oid===commit)kept.push(commit);
 }
 return kept;
}

/**
 * One ref operation (`release_refs` / `pin_sources`) runs at most once per
 * operation id, under the caller's Task lease: a journal written before the
 * first side effect and completed after the last. A re-delivery waits for the
 * lease, then replays the finished result without touching Git, so any reply
 * carrying `ref_operation` proves no execution of that id is still running —
 * the server's fence for a timed-out request. The same id with other content
 * is refused without side effects.
 */
export async function journaledRefOperation<T extends Record<string,unknown>>(operationId:string,digest:RequestDigest,run:()=>Promise<T>):Promise<{replayed:boolean;result:T}|'conflict'>{
 if(!UUID.test(operationId))throw new Error('workspace_ref_operation_invalid');
 const path=join(configDir(),'workspace-ref-operations',`${operationId}.json`);
 const prior=await readJson(path);
 // Settled as cancelled by a later operation: it never runs, whatever its content.
 if(prior?.state==='cancelled'){await syncExistingDurable(path);return {replayed:true,result:{cancelled:true,retained:[],pinned:[]} as unknown as T};}
 if(prior&&!sameRequest(prior,digest))return 'conflict';
 const fingerprint=digest.current,digest_version=DIGEST_VERSION;
 if(prior?.state==='done'&&prior.result&&typeof prior.result==='object'){
  // A replay is an acknowledgement too: the record it replays is made durable
  // first. A legacy (v1) record is rewritten bound to the full v2 digest, which
  // is itself the barrier; from then on only that exact content replays it.
  if(prior.digest_version===DIGEST_VERSION)await syncExistingDurable(path);
  else await writeJsonDurable(path,{...prior,fingerprint,digest_version});
  return {replayed:true,result:prior.result as T};
 }
 // Durable (fsync, rename, directory fsync) before the first side effect and
 // before the reply: power loss never forgets an operation the server was told
 // ended, so a late copy of it cannot run again. A failed write throws: no ack.
 await writeJsonDurable(path,{fingerprint,digest_version,state:'running',at:new Date().toISOString()});
 const result=await run();
 await writeJsonDurable(path,{fingerprint,digest_version,state:'done',result,at:new Date().toISOString()});
 return {replayed:false,result};
}
/** The workspace a ref operation acts for: who owns names, keepers and the rebuild fence. */
export interface RefOperationScope {id:string;generation:number;locationId:string;integrationId?:string|null;epoch?:number}
/**
 * Digest of everything a ref operation's execution depends on: its lists and
 * flags (v1) and, from v2, the workspace identity (id, generation, Location,
 * integration) and materialization epoch, which decide owned names, keepers
 * and the rebuild fence. `legacy` recognises journals written before v2.
 */
export function refOperationDigest(refs:readonly RefRelease[]|undefined,pins:readonly string[]|undefined,settle?:readonly string[],more:{keep?:readonly string[];release_keepers?:readonly string[];source_fence?:boolean}={},scope?:RefOperationScope):RequestDigest{
 const list=[...new Set((refs??[]).map(r=>JSON.stringify([r.ref,r.expected_commit??null,Boolean(r.prefix),r.kept_epoch??null])))].sort();
 const set=(v:readonly string[]|undefined)=>[...new Set(v)].sort();
 // Later fields are part of the v1 content only when present, so earlier digests stay the same.
 const content={refs:list,pins:set(pins),...(settle?.length?{settle:set(settle)}:{}),
  ...(more.keep?.length?{keep:set(more.keep)}:{}),...(more.release_keepers?.length?{release_keepers:set(more.release_keepers)}:{}),...(more.source_fence?{source_fence:true}:{})};
 const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 return {legacy:hash({v:1,...content}),current:hash({v:2,...content,workspace:scope?{id:scope.id,generation:scope.generation,location:scope.locationId,integration:scope.integrationId??null,epoch:scope.epoch??null}:null})};
}

/**
 * Settle earlier ref operations (reclaim 3). Must run under the same Task lease
 * those operations ran under (the identity's), which a delivery of them cannot
 * wait for: an execution is either over or still holds the lease (the caller
 * then answers busy). A finished operation reports its recorded result. Any
 * other — never received, or interrupted by a crash part-way — is recorded as
 * cancelled before this returns, so no later delivery of it can touch Git.
 * An interrupted or pre-journal one may have deleted some of its refs; the
 * server therefore treats a cancelled operation's sources as possibly deleted.
 */
export async function settleRefOperations(operationIds:readonly string[]){
 const settled:Array<{operation_id:string;state:'finished'|'cancelled';retained_refs?:Array<{ref:string;reason:string}>}>=[];
 for(const id of new Set(operationIds)){
  if(!UUID.test(id))throw new Error('workspace_ref_operation_invalid');
  const path=join(configDir(),'workspace-ref-operations',`${id}.json`);
  const prior=await readJson(path);
  if(prior?.state==='done'&&prior.result&&typeof prior.result==='object'&&!(prior.result as {cancelled?:boolean}).cancelled){
   const retained=Array.isArray((prior.result as {retained?:unknown}).retained)?(prior.result as {retained:Array<{ref:string;reason:string}>}).retained:[];
   await syncExistingDurable(path);
   settled.push({operation_id:id,state:'finished',retained_refs:retained.slice(0,200)});
   continue;
  }
  if(prior?.state==='cancelled')await syncExistingDurable(path);
  else await writeJsonDurable(path,{...(prior?.fingerprint?{fingerprint:prior.fingerprint}:{}),...(prior?.digest_version!==undefined?{digest_version:prior.digest_version}:{}),state:'cancelled',at:new Date().toISOString()});
  settled.push({operation_id:id,state:'cancelled'});
 }
 return settled;
}

/**
 * Run-history snapshots: before a branch release, each saved Run checkpoint of
 * this generation that the target cannot reach gets an owned, content-addressed
 * ref, so a past Run's file preview still reads its exact version. The server
 * releases them after the configured history retention; the branch itself is
 * released now. Commits the target reaches need no ref.
 */
export class RunHistoryError extends Error{constructor(readonly commit:string,detail:string){super('workspace_run_history_failed');this.cause=detail;}}
export async function keepRunHistory(repoRoot:string,ref:ExecutionWorkspaceRef,target:string|null,commits:readonly string[]):Promise<{kept:string[];unavailable:string[]}>{
 const kept:string[]=[],unavailable:string[]=[];
 for(const commit of new Set(commits)){
  if(!COMMIT.test(commit))continue;
  // Only Git's clean answer that the object is gone (or is no commit) skips a
  // version, and it is reported as unavailable; an unreadable object store
  // throws before the branch is released, so the release retries.
  const presence=await versionPresence(repoRoot,commit);
  if(presence==='failed')throw new RunHistoryError(commit,'object store unreadable');
  if(presence!=='commit'){unavailable.push(commit);continue;}
  // A failed ancestry check reads as "not reachable": the ref is kept anyway.
  if(target&&await isAncestor(repoRoot,commit,target))continue;
  const name=`refs/rainver/run-history/${ref.id}/g${ref.generation}/${commit}`;
  try{
   const current=await readRef(repoRoot,name);
   if(current!==commit){
    const created=await runLocationGit(['-c','core.fsync=reference','update-ref','-m','rainver: keep Run history',name,commit,current??''],repoRoot);
    if(created.code!==0)throw new RunHistoryError(commit,created.stderr.trim().slice(0,200));
   }
   // Also when it already held the commit: durable before the branch goes.
   await syncRefDurable(repoRoot,name,commit);
  }catch(error){
   if(error instanceof RefReadError)throw new RunHistoryError(commit,String(error.cause??error.message));
   throw error;
  }
  kept.push(commit);
 }
 return {kept,unavailable};
}

/**
 * After a proven branch release, the identity's small receipts are redundant:
 * the server keeps the audit, head/base, baseline and the launch-sequence floor
 * it sends back on the next materialization. Unfinished native journals stay.
 */
export async function reclaimWorkspaceReceipts(locationId:string,key:string,ref:ExecutionWorkspaceRef){
 await rm(join(configDir(),'workspace-sequences',locationId,`${key}.json`),{force:true});
 await rm(join(configDir(),'workspace-baselines',locationId,`${key}.json`),{force:true});
 const suffix=`:${ref.id}:g${ref.generation}.json`;
 for(const directory of ['workspace-launches','task-runs']){
  for(const name of await readdir(join(configDir(),directory)).catch(()=>[] as string[])){
   if(!name.endsWith(suffix))continue;
   const path=join(configDir(),directory,name),receipt=await readJson(path);
   if(directory==='task-runs'&&receipt?.task_id!==key)continue;
   if(directory==='workspace-launches'&&(receipt?.id!==ref.id||receipt?.generation!==ref.generation))continue;
   await rm(path,{force:true});
  }
 }
 await cleanupNativeWorkspaceReceipts(locationId,key);
}
