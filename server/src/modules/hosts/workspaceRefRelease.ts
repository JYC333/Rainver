import {randomUUID} from 'node:crypto';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {workspaceHostFailureIsTemporary} from '../projectFolders/workspacePolicy.js';
import type {ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import type {HostConnectionRegistry,TaskBranchReply} from './connectionRegistry.js';
import {workspaceLocationFrame} from './workspaceLocation.js';
import {freeSourceCommits,ownedRefReleases,recordRetention,RECLAIM_PROTOCOL,REF_RELEASE_PAGE,REF_SETTLE_PROTOCOL,type RefRelease} from './workspaceRetention.js';
import type {WorkspaceCleanupResource} from './workspaceCleanup.js';
import {claimSourceDeletions,clearSourceDeletions,keepSourceDeletionIntents,lockSourceCommits,sourcesFencedByOthers} from './workspaceSourceFence.js';

/**
 * Ref releases that do not fit in, or must not happen with, the branch release:
 *
 * - `ref_pages`: the rest of a proven release (owned refs beyond the first Host
 *   page, and shared/merge refs beyond the first frame). Runs immediately, one
 *   page per round, with a persisted owned-ref cursor. The retention stays
 *   `reclaiming` until the last page is done.
 * - `local_preimages` / `run_history`: exact owned refs released after their
 *   configured retention.
 *
 * Every Host deletion is a durable, fenced operation, never "the RPC returned":
 *
 * 1. **Claim.** Under the workspace row lock the round checks that its Job
 *    still owns the resource (operation id) and that no earlier operation is
 *    unconfirmed, takes only items that are due in the *current* row (a
 *    renewal that committed first wins), locks and re-checks shared `sources`
 *    refs against every dependent on the Host, records their durable deletion
 *    intents (workspaceSourceFence) and persists the exact batch as
 *    `inflight` under that operation id. Only then is it sent. Until the
 *    confirmation clears the intents, the fence trigger refuses every new
 *    dependent of those commits, so none can appear during the deletion.
 * 2. **Execute.** The Host runs that operation id at most once under the Task
 *    lease, journaled; a re-delivery waits for the lease and replays.
 * 3. **Confirm.** Only a reply carrying `ref_operation` equal to the inflight id
 *    proves the operation ended. A timeout, disconnect, busy lease or any other
 *    answer leaves `inflight` in place: the next round re-sends the same id
 *    (never a new one), so a slow original can never delete after its
 *    confirmation. A resource replaced by a renewal carries `inflight` along.
 * 4. **Clear.** The transaction proving the end removes the operation's
 *    intents. A commit of it that has a dependent anyway and that no other
 *    unended operation fences is re-pinned under its shared name by a journaled
 *    operation (no deletion of it can run any more); a pin the Host reports
 *    missing stays claimed and fails visibly, never `cleaned`.
 * 5. **Settle.** A claim made without the complete fence (no `fence` mark) is
 *    never re-sent. One settle operation under the same Task lease (reclaim 4)
 *    first keeps every one of its commits that has a dependent under an
 *    independent keeper ref (`refs/rainver/source-keepers/`, which no release
 *    list can name), then makes the Host report the earlier operation finished
 *    or cancel it for good, then re-creates the shared name of each kept commit
 *    no other unended operation fences and drops that keeper — protection,
 *    settle and restoration in one Host call, with no reply or Job in between.
 *    A keeper another operation's fence still holds stays recorded
 *    (`keepers`) until a later operation restores its shared name and drops
 *    it; the resource is never `cleaned` before. A commit whose object was
 *    already gone when the keeper was made was lost before this mechanism
 *    (an unfenced deletion before the Host upgrade): the resource is
 *    `blocked` with `workspace_source_lost_before_fence`, never `cleaned`.
 *    A reclaim-4 Host deletes a shared `sources` ref only for a fence-marked
 *    request, so a late copy of an unfenced one deletes none.
 *
 * Renewal: Run history is renewed only when the Host reports a newer keeper
 * epoch for it (a later release kept it again); the Host records that epoch
 * under the same Task lease before re-creating the ref and refuses an older
 * expiry (`ref_renewed`). Local preimages keep their own due time and are
 * never renewed. An item renewed while its deletion was inflight stays listed
 * with its new due time whatever the Host did.
 *
 * History inventory: a release reports one bounded page of Run-history refs
 * with a cursor; the `run-history-g<n>` resource persists the cursor
 * (`history_scan`) and reads the remaining pages before deleting anything.
 */
export type DelayedRefKind='ref_pages'|'local_preimages'|'run_history';
export interface RefInflight {
 /** The Host operation id; re-sent unchanged until a reply confirms it. */
 operation_id:string;
 /** The exact items sent, as they were in the list at claim time (due/epoch versions). */
 refs:RefRelease[];
 /** Shared sources commits in `refs`: re-checked after confirmation. */
 sources:string[];
 /** A re-pin operation (sources that gained a dependent after their deletion). */
 pins?:string[];
 /** ref_pages: the owned-ref cursor after this page; applied on confirmation. */
 owned_after?:string|null;
 /** Candidates the claim kept back for other dependents. */
 shared_retained?:number;
 /** Claimed with a durable intent per sent source (0020). Absent: claimed before the fence covered it. */
 fence?:number;
 /** A settle operation (reclaim 4) ending this earlier, unfenced operation for good before anything else. */
 settle?:RefInflight;
 /** Settle: commits kept under keeper refs before the earlier operation is settled (those with a dependent). */
 keep?:string[];
 /** Keepers dropped once the shared name holds the commit again (in the same operation, after `pins`). */
 release_keepers?:string[];
 /**
  * A settle built keeper-first (round 8 on): its `keep` was decided under the
  * commits' locks with every earlier operation's intents in place, so its
  * confirmation needs no later re-pin. A settle without it (persisted by an
  * earlier server, which may have kept nothing) is never sent again: it is
  * converted into a new keeper-first settle that also settles it.
  */
 keeper_first?:true;
}
/** The version of the claim protocol whose deletions are fenced from claim to proven end. */
export const FENCE_VERSION=2;
/** Shared sources an operation may delete: its fenced list and any `sources` ref it carries. */
export function sourcesOf(op:RefInflight){
 return [...new Set([...(op.sources??[]),...op.refs.filter(x=>x.ref.startsWith(SOURCE_PREFIX)).map(x=>x.ref.slice(SOURCE_PREFIX.length))])];
}
/** A shared-source deletion claimed without the complete fence: never re-sent, settled first. */
export function unfencedDeletion(op:RefInflight|undefined){
 return Boolean(op&&op.fence!==FENCE_VERSION&&!op.settle&&sourcesOf(op).length);
}
/** Bound on nested settles (the Host accepts at most 20 settle ids per operation). */
export const MAX_SETTLE_CHAIN=16;
/** An operation and every earlier one it settles, outermost first; the last is the deletion being ended. */
export function settleChain(op:RefInflight):RefInflight[]{
 const chain:RefInflight[]=[];
 for(let o:RefInflight|undefined=op;o&&chain.length<=MAX_SETTLE_CHAIN;o=o.settle)chain.push(o);
 return chain;
}
/** The deletion a settle (of any nesting) ends: the innermost operation. */
export function deletionOf(op:RefInflight){return settleChain(op).at(-1)!;}
/**
 * A settle persisted without the keeper-first plan (an earlier server's, or a
 * nested one around it): sending it as it is could end an executed deletion
 * without protecting its dependents and without a later re-pin.
 */
export function legacySettle(op:RefInflight|undefined){return Boolean(op?.settle&&!op.keeper_first);}
/** The next step is a (new) keeper-first settle: an unfenced deletion, or a legacy settle around one. */
export function needsKeeperSettle(op:RefInflight|undefined){return unfencedDeletion(op)||legacySettle(op);}
/** The Host level this resource's next step needs: settling an unfenced deletion, or any keeper work, needs reclaim 4. */
export function requiredRefLevel(r:Pick<WorkspaceCleanupResource,'inflight'|'keepers'>){
 return r.keepers?.length||r.inflight&&(r.inflight.settle||r.inflight.keep?.length||r.inflight.release_keepers?.length||unfencedDeletion(r.inflight))?REF_SETTLE_PROTOCOL:RECLAIM_PROTOCOL;
}

const SOURCE_PREFIX='refs/rainver/sources/';
const toHost=(refs:readonly RefRelease[])=>refs.map(({due_at:_,...r})=>r);
const dueOf=(r:RefRelease)=>r.due_at?Date.parse(r.due_at):-Infinity;
const sameVersion=(a:RefRelease|undefined,b:RefRelease)=>Boolean(a)&&(a!.due_at??null)===(b.due_at??null)&&(a!.kept_epoch??null)===(b.kept_epoch??null);
const FINAL_RETAINED=new Set(['ref_release_refused','ref_moved','ref_owner_rebuilt','ref_renewed']);

/**
 * Merge delayed items into a list. Local preimages keep their own due time.
 * Run history is renewed (new due, newer epoch) only when the reported keeper
 * epoch is newer than the listed one; otherwise the listed item stays as is.
 */
export function mergeDelayedRefs(kind:'local_preimages'|'run_history',existing:readonly RefRelease[],refs:readonly RefRelease[],at:Date):RefRelease[]{
 const merged=new Map<string,RefRelease>(existing.map(i=>[i.ref,i]));
 for(const item of refs){
  const prior=merged.get(item.ref),due=at.toISOString();
  if(!prior){merged.set(item.ref,{...item,due_at:due});continue;}
  if(kind==='run_history'&&(item.kept_epoch??-1)>(prior.kept_epoch??-1))
   merged.set(item.ref,{...prior,...item,due_at:Date.parse(prior.due_at??'')>at.getTime()?prior.due_at:due});
 }
 return [...merged.values()];
}

/**
 * Enqueue (or merge) a delayed release. Returns the resource key, the time its
 * Job first looks and the latest due time it now holds. Call inside the
 * transaction that records the release outcome.
 */
export async function enqueueRefRelease(db:Queryable,w:Pick<ExecutionWorkspaceRow,'id'|'generation'|'space_id'>,kind:DelayedRefKind,refs:RefRelease[],userId:string,at:Date,extra:Partial<WorkspaceCleanupResource>={}):Promise<{key:string;at:Date;until:Date}>{
 const key=kind==='ref_pages'?`refs-g${w.generation}${extra.release_epoch!==undefined?`-e${extra.release_epoch}`:''}`:`${kind==='local_preimages'?'local-preimages':'run-history'}-g${w.generation}`;
 const existing=(await db.query<{resource:WorkspaceCleanupResource|null}>('SELECT cleanup_json->$2 AS resource FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id,key])).rows[0]?.resource??null;
 const live=existing&&existing.state!=='cleaned'?existing:null;
 let list:RefRelease[];
 if(kind==='ref_pages'){
  // One page run per release: a repeated report of that release changes nothing.
  if(live)return {key,at:new Date(live.next_retry_at??at.toISOString()),until:at};
  list=refs;
 }else list=mergeDelayedRefs(kind,live?.release_refs??[],refs,at);
 const scan=extra.history_scan??live?.history_scan;
 const dues=list.map(dueOf).filter(Number.isFinite);
 if(scan)dues.push(Date.parse(scan.due_at));
 // An unconfirmed operation or an unfinished history scan is continued at once.
 const first=live?.inflight||scan?new Date():kind==='ref_pages'||!dues.length?at:new Date(Math.min(...dues)),until=kind==='ref_pages'||!dues.length?at:new Date(Math.max(...dues));
 // A fresh operation id fences any older Job's database writes; the Host-side
 // fence is `inflight`, which is carried over and re-sent, never dropped.
 const resource:WorkspaceCleanupResource={version:1,kind,operation_id:randomUUID(),workspace:{id:w.id,generation:w.generation},expected_commit:'',retain_branch:true,release_refs:list,state:'pending',attempts:0,error:null,next_retry_at:first.toISOString(),
  ...(live?.retained_count!==undefined?{retained_count:live.retained_count}:{}),...(live?.inflight?{inflight:live.inflight}:{}),...(live?.keepers?.length?{keepers:live.keepers}:{}),...extra,...(scan?{history_scan:scan}:{})};
 await db.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1`,[w.id,key,JSON.stringify(resource)]);
 await new PgJobQueueRepository(db).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:userId,payload:{workspace_id:w.id,resource_key:key,operation_id:resource.operation_id},scheduled_at:first});
 return {key,at:first,until};
}

type Row=ExecutionWorkspaceRow&{host_owner:string|null;host_kind:string;host_reclaim?:number|null};
type Save=(resource:WorkspaceCleanupResource,also?:(tx:Queryable)=>Promise<void>)=>Promise<void>;

/** The resource as it is now, locked, if this Job still owns it. */
async function owned(tx:Queryable,w:{id:string},key:string,operationId:string){
 const current=(await tx.query<{resource:WorkspaceCleanupResource|null}>('SELECT cleanup_json->$2 AS resource FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id,key])).rows[0]?.resource??null;
 return current&&current.operation_id===operationId?current:null;
}
async function write(tx:Queryable,w:{id:string},key:string,resource:WorkspaceCleanupResource){
 await tx.query('UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true),updated_at=now() WHERE id=$1',[w.id,key,JSON.stringify(resource)]);
}

/** Errors that a Host speaking the journaled protocol confirmed: never re-judged as an old-protocol pause. */
export const CONFIRMED_REF_FAILURES=new Set(['workspace_refs_release_failed','workspace_source_repin_missing','workspace_ref_operation_conflict','workspace_source_lost_before_fence']);
/** How long an old-protocol Host's ref work waits before looking again (reconcile resumes it at once after an upgrade). */
export const HOST_UPGRADE_WAIT_MS=10*60_000;

export async function advanceRefRelease(db:Queryable,w:Row,key:string,r:WorkspaceCleanupResource,userId:string,hosts:HostConnectionRegistry,workspaceRoot:string|undefined,save:Save){
 // A Host below the level this resource needs cannot prove its operation
 // ended: nothing is sent and no attempt is spent; an inflight claim (and its
 // fence) stays as it is. Reconcile resumes this once the Host reports the level.
 const needed=requiredRefLevel(r);
 if((w.host_reclaim??0)<needed)return hostUpgradeWait(r,save,needed);
 const next={...r,state:'running' as const,attempts:r.attempts+1};
 await save(next);
 const wait=async(error:string,ms:number):Promise<never>=>{
  await save({...next,state:'retry_wait',attempts:r.attempts,error,next_retry_at:new Date(Date.now()+ms).toISOString()});
  throw new JobDeferredError(error,ms);
 };
 const page=async(error:string):Promise<never>=>{throw new JobDeferredError(error,1000);};
 let frame:Awaited<ReturnType<typeof workspaceLocationFrame>>;
 let inflight=r.inflight;
 let answer:TaskBranchReply<'execution_workspace_command'>;
 try{
  if(w.host_kind==='remote'&&w.host_owner!==userId)throw new Error('workspace_cleanup_host_authority_changed');
  await assertProjectWriterForMutation(db,w.space_id,w.project_id,userId);
  const located=await workspaceLocationFrame(db,w,r.workspace,workspaceRoot);
  frame=r.release_epoch!==undefined?{...located,execution_workspace:{...located.execution_workspace,materialization_epoch:r.release_epoch}}:located;

  // History inventory first: every page gets its expiry before anything is deleted.
  if(!inflight&&r.kind==='run_history'&&r.history_scan){
   const scan=r.history_scan;
   const inspected=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:frame,action:'inspect',operation_id:randomUUID(),retain_branch:true,history_after:scan.after});
   if(!inspected.ok||!inspected.inventory)throw new Error(inspected.error??'workspace_history_inventory_failed');
   const inv=inspected.inventory,epochs=inv.history_epochs??{};
   const items=(inv.history_refs??[]).map(c=>({ref:`refs/rainver/run-history/${w.id}/g${r.workspace.generation}/${c}`,expected_commit:c,kept_epoch:epochs[c]??scan.epoch}));
   const continued=await withQueryableTransaction(db,async tx=>{
    const current=await owned(tx,w,key,r.operation_id);
    if(!current)return false;
    const more=inv.history_refs_next;
    const {history_scan:_,...rest}=current;
    await write(tx,w,key,{...rest,state:'retry_wait',attempts:0,error:null,next_retry_at:new Date(Date.now()+1000).toISOString(),
     release_refs:mergeDelayedRefs('run_history',current.release_refs??[],items,new Date(scan.due_at)),...(more?{history_scan:{...scan,after:more}}:{})});
    return true;
   });
   if(!continued)return {skipped:true};
   return page('workspace_history_next_page');
  }

  if(inflight&&needsKeeperSettle(inflight)){
   // A deletion claimed before the source fence existed (or before 0020 kept
   // one intent per operation): dependents may have registered meanwhile, so
   // it is never re-sent. One settle operation under the same Task lease keeps
   // each of its commits that has a dependent under a keeper ref first, then
   // ends it for good (its recorded result, or cancelled so no delivery of it
   // can delete afterwards), then restores the shared name of each kept commit
   // no other unended operation fences and drops that keeper. Which commits
   // are kept is decided here, under their locks and with the earlier
   // operation's intents in place, so no new dependent can appear until the
   // settle is confirmed. Persisted before sending.
   //
   // A settle an earlier server persisted (no `keeper_first`: it may keep
   // nothing, and its confirmation would skip the re-pin) is never re-sent and
   // never changed in place (its id may already have a Host journal of other
   // content). It becomes the inner part of a new operation under a fresh id
   // that settles the whole chain — every wrapper and the deletion — after the
   // keepers, so a deletion that already ran still leaves each dependent commit
   // referenced. Nested and partially confirmed chains are handled alike.
   const converted=await withQueryableTransaction(db,async tx=>{
    const current=await owned(tx,w,key,r.operation_id);
    if(!current)return 'fenced' as const;
    if(!current.inflight||!needsKeeperSettle(current.inflight))return current;
    const earlier=current.inflight,chain=settleChain(earlier);
    if(chain.length>MAX_SETTLE_CHAIN)return 'too_deep' as const;
    const deletion=chain.at(-1)!,commits=sourcesOf(deletion),chainIds=chain.map(o=>o.operation_id);
    const fence={hostId:w.execution_host_id,workspaceId:w.id,generation:r.workspace.generation};
    await lockSourceCommits(tx,w.execution_host_id,commits);
    await keepSourceDeletionIntents(tx,fence,deletion.operation_id,commits);
    const free=new Set(commits.length?await freeSourceCommits(tx,fence,commits):[]);
    // Whatever an earlier wrapper planned to keep stays kept too: its keeper may exist.
    const planned=chain.flatMap(o=>[...(o.keep??[]),...(o.release_keepers??[])]).filter(c=>commits.includes(c));
    const keep=[...new Set([...commits.filter(c=>!free.has(c)),...planned])];
    const others=await sourcesFencedByOthers(tx,w.execution_host_id,keep,chainIds);
    const restore=keep.filter(c=>!others.has(c));
    const resource:WorkspaceCleanupResource={...current,state:'running',attempts:next.attempts,inflight:{operation_id:randomUUID(),refs:[],sources:[],fence:FENCE_VERSION,keeper_first:true,settle:earlier,
     ...(keep.length?{keep}:{}),...(restore.length?{pins:restore,release_keepers:restore}:{})}};
    await write(tx,w,key,resource);
    return resource;
   });
   if(converted==='fenced')return {skipped:true};
   if(converted==='too_deep'){
    await save({...next,state:'blocked',attempts:next.attempts,error:'workspace_ref_settle_chain_too_deep',blocked_host_level:w.host_reclaim??0,next_retry_at:null} as WorkspaceCleanupResource);
    return {cleanup_state:'blocked'};
   }
   Object.assign(next,converted);
   inflight=converted.inflight;
  }

  if(!inflight){
   // The next owned page after the cursor (ref_pages): an RPC, before the claim transaction.
   let ownedPage:{release:RefRelease[];retained:number}={release:[],retained:0},cursor:string|null|undefined=r.owned_after;
   if(r.kind==='ref_pages'&&typeof r.owned_after==='string'){
    const inspected=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:frame,action:'inspect',operation_id:randomUUID(),retain_branch:true,list_after:r.owned_after});
    if(!inspected.ok||!inspected.inventory)throw new Error(inspected.error??'workspace_ref_inventory_failed');
    ownedPage=await ownedRefReleases(db,w,inspected.inventory.owned_refs??[]);
    cursor=inspected.inventory.owned_refs_next??null;
   }
   // Claim: short transaction, no network I/O. Only items due in the current
   // row; shared sources re-checked against every dependent on the Host.
   const claimed=await withQueryableTransaction(db,async tx=>{
    const current=await owned(tx,w,key,r.operation_id);
    if(!current)return 'fenced' as const;
    if(current.inflight)return current;
    if(current.keepers?.length){
     // Kept commits whose shared name no unended operation can delete any more:
     // one operation restores the shared ref, then drops the keeper it replaces.
     await lockSourceCommits(tx,w.execution_host_id,current.keepers);
     const fencedNow=await sourcesFencedByOthers(tx,w.execution_host_id,current.keepers);
     const ready=current.keepers.filter(c=>!fencedNow.has(c));
     if(ready.length){
      const restoring:WorkspaceCleanupResource={...current,state:'running',attempts:next.attempts,inflight:{operation_id:randomUUID(),refs:[],sources:[],fence:FENCE_VERSION,pins:ready,release_keepers:ready}};
      await write(tx,w,key,restoring);
      return restoring;
     }
    }
    const now=Date.now();
    const due=(current.release_refs??[]).filter(x=>dueOf(x)<=now);
    const candidates=[...ownedPage.release,...due.filter(d=>!ownedPage.release.some(o=>o.ref===d.ref))];
    const sources=candidates.filter(c=>c.ref.startsWith(SOURCE_PREFIX)).map(c=>c.ref.slice(SOURCE_PREFIX.length));
    const fence={hostId:w.execution_host_id,workspaceId:w.id,generation:r.workspace.generation};
    // The same per-(Host, commit) lock every dependent writer's trigger takes:
    // a dependent committed before this point is seen below; one after it is
    // refused by the intent recorded below until this deletion has ended.
    await lockSourceCommits(tx,w.execution_host_id,sources);
    const free=new Set(sources.length?await freeSourceCommits(tx,fence,sources):[]);
    const kept=candidates.filter(c=>c.ref.startsWith(SOURCE_PREFIX)&&!free.has(c.ref.slice(SOURCE_PREFIX.length)));
    const sendable=candidates.filter(c=>!kept.includes(c));
    // Sources kept for another dependent leave the list (counted); the rest waits its turn.
    const operationId=randomUUID();
    let batch=sendable.slice(0,REF_RELEASE_PAGE);
    const batchSources=batch.filter(b=>b.ref.startsWith(SOURCE_PREFIX)).map(b=>b.ref.slice(SOURCE_PREFIX.length));
    const fenced=await claimSourceDeletions(tx,fence,operationId,batchSources);
    // Another unended operation on this Host already deletes that same ref
    // (its own intent fences it): this list hands it over instead of sending it twice.
    const handedOver=new Set(batchSources.filter(c=>!fenced.has(c)).map(c=>`${SOURCE_PREFIX}${c}`));
    batch=batch.filter(b=>!handedOver.has(b.ref));
    const claim:RefInflight={operation_id:operationId,refs:batch,sources:batchSources.filter(c=>fenced.has(c)),fence:FENCE_VERSION,
     // An owned page (at most one Host page) always fits first in the batch.
     ...(r.kind==='ref_pages'&&typeof r.owned_after==='string'?{owned_after:cursor??null}:{}),shared_retained:ownedPage.retained+kept.length};
    const keptRefs=new Set([...kept.map(k=>k.ref),...handedOver]);
    const claimedResource:WorkspaceCleanupResource={...current,state:'running',attempts:next.attempts,inflight:claim,release_refs:(current.release_refs??[]).filter(x=>!keptRefs.has(x.ref))};
    await write(tx,w,key,claimedResource);
    return claimedResource;
   });
   if(claimed==='fenced')return {skipped:true};
   // Every later save of this round keeps the claim: the fence is never dropped.
   Object.assign(next,claimed);
   inflight=claimed.inflight!;
  }
  if(!inflight.refs.length&&!inflight.pins?.length&&!inflight.settle&&!inflight.keep?.length&&!inflight.release_keepers?.length){
   answer={ok:true,branch:null,commit:null,error:null,inventory:{ref_operation:inflight.operation_id,retained_refs:[]}} as unknown as TaskBranchReply<'execution_workspace_command'>;
  }else{
   answer=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:frame,action:'release_refs',operation_id:inflight.operation_id,retain_branch:true,
    release_refs:toHost(inflight.refs),...(inflight.pins?.length?{pin_sources:inflight.pins}:{}),...(inflight.settle?{settle_operations:settleChain(inflight).slice(1).map(o=>o.operation_id)}:{}),
    ...(inflight.keep?.length?{keep_sources:inflight.keep}:{}),...(inflight.release_keepers?.length?{release_keepers:inflight.release_keepers}:{}),
    // Only a fenced claim may delete shared sources on a reclaim-4 Host.
    ...(inflight.fence===FENCE_VERSION&&inflight.refs.some(x=>x.ref.startsWith(SOURCE_PREFIX))?{source_fence:true as const}:{})});
  }
 }catch(error){
  const message=error instanceof Error?error.message:String(error);
  if(error instanceof JobDeferredError)throw error;
  if(workspaceHostFailureIsTemporary(message))return wait(message,30000);
  answer={ok:false,error:message,branch:null,commit:null};
 }
 const confirmed=Boolean(inflight)&&answer.inventory?.ref_operation===inflight!.operation_id;
 // A settle's outcome is the deletion's (the innermost operation); its wrappers did no deletion.
 const settled=confirmed&&inflight!.settle?answer.inventory?.settled_operations?.find(x=>x.operation_id===deletionOf(inflight!).operation_id):undefined;
 if(confirmed&&inflight!.settle&&!settled){
  // A Host that does not know settling ran an empty operation under that id:
  // nothing happened. The next settle gets a fresh id (that one would only replay).
  const stale=inflight!.operation_id;
  const renewed=await withQueryableTransaction(db,async tx=>{
   const current=await owned(tx,w,key,r.operation_id);
   if(!current||current.inflight?.operation_id!==stale)return null;
   const resource:WorkspaceCleanupResource={...current,inflight:{...current.inflight,operation_id:randomUUID()}};
   await write(tx,w,key,resource);
   return resource;
  });
  if(!renewed)return {skipped:true};
  return hostUpgradeWait({...next,...renewed,attempts:r.attempts},save,REF_SETTLE_PROTOCOL);
 }
 if(!confirmed){
  // Not proven ended (timeout, disconnect, busy, refusal): the inflight
  // operation stays and is re-sent with the same id. Nothing is released.
  if(workspaceHostFailureIsTemporary(answer.error))return wait(answer.error!,30000);
  // A keeper or shared name the Host could not write while its object exists
  // (ref lock, I/O, permission): nothing after it ran and the journal is
  // unfinished. Retried with the same id, never blocked as a lost source.
  if(answer.error==='workspace_source_ref_write_failed')return wait(answer.error,Math.min(600_000,30000*2**Math.min(next.attempts,5)));
  const state=next.attempts>=8?'blocked':'retry_wait';
  const updated={...next,state,blocked_host_level:w.host_reclaim??0,error:answer.error??'workspace_refs_release_unconfirmed',next_retry_at:state==='retry_wait'?new Date(Date.now()+Math.min(3600000,30000*2**next.attempts)).toISOString():null} as WorkspaceCleanupResource;
  await save(updated);
  if(state==='retry_wait')throw new JobDeferredError(updated.error!,new Date(updated.next_retry_at!).getTime()-Date.now());
  return {cleanup_state:state};
 }
 const sent=inflight!;
 // The operation whose end is proven: the sent one, or the deletion it settled (through every wrapper).
 const op=deletionOf(sent);
 // A cancelled operation changed no bookkeeping, but it may have deleted any
 // of its sources before it was cancelled (a crash part-way, a pre-journal Host).
 const cancelled=settled?.state==='cancelled';
 const retainedNow=cancelled?[]:(sent.settle?settled!.retained_refs??[]:answer.inventory?.retained_refs??[]);
 const failed=retainedNow.some(t=>t.reason==='ref_release_failed');
 // End of the operation: one short transaction. Clears its fence and protects
 // what still has a dependent once no unended deletion of it remains.
 const outcome=await withQueryableTransaction(db,async tx=>{
  const current=await owned(tx,w,key,r.operation_id);
  if(!current||current.inflight?.operation_id!==sent.operation_id)return null;
  const retainedBy=new Map(retainedNow.map(t=>[t.ref,t.reason]));
  let list:RefRelease[]=current.release_refs??[];
  let finalRetained=0;
  if(!cancelled){
   list=[];
   const claimedItems=new Map(op.refs.map(x=>[x.ref,x]));
   for(const item of current.release_refs??[]){
    const claimedItem=claimedItems.get(item.ref);
    if(!claimedItem){list.push(item);continue;}
    // Renewed while inflight: listed with its new due time whatever the Host did.
    if(!sameVersion(item,claimedItem)){list.push(item);continue;}
    const reason=retainedBy.get(item.ref);
    if(reason&&!FINAL_RETAINED.has(reason)){list.push(item);continue;}
    if(reason&&reason!=='ref_renewed')finalRetained++;
   }
   // Owned-page items are not in the list: their retained reasons count here.
   for(const x of op.refs)if(!(current.release_refs??[]).some(i=>i.ref===x.ref)){
    const reason=retainedBy.get(x.ref);
    if(reason&&!FINAL_RETAINED.has(reason))list.push(x);else if(reason)finalRetained++;
   }
  }
  const commits=sourcesOf(op);
  await lockSourceCommits(tx,w.execution_host_id,commits);
  // Its intents stop fencing writers, in this same transaction.
  const alone=await clearSourceDeletions(tx,op.operation_id,w.execution_host_id,commits);
  for(const o of settleChain(sent))if(o!==op)await clearSourceDeletions(tx,o.operation_id);
  // A commit of the ended deletion that has a dependent (registered before the
  // fence covered it) is re-pinned — under the same name, which is safe only
  // because no deletion of it can still run: this one ended and no other
  // unended operation fences it (the last one to end protects it).
  // A settle protected its commits inside its own operation (keepers, then the
  // shared names): nothing is pinned after it. For a fenced deletion this finds
  // nothing (the fence refused every new dependent); it stays as a last guard.
  // Only a keeper-first settle is exempt: a legacy one is converted before it is sent.
  const protectedInside=Boolean(sent.settle&&sent.keeper_first);
  const free=new Set(commits.length&&!protectedInside?await freeSourceCommits(tx,{hostId:w.execution_host_id,workspaceId:w.id,generation:r.workspace.generation},commits):[]);
  const pins=protectedInside?[]:commits.filter(c=>alone.has(c)&&!free.has(c));
  const pinned=new Set(answer.inventory?.pinned_sources??[]),kept=new Set(answer.inventory?.kept_sources??[]);
  // Keeper bookkeeping: what this operation kept or released, as the Host reports Git now.
  const handled=new Set([...(sent.keep??[]),...(sent.release_keepers??[])]);
  const keepers=[...new Set([...(current.keepers??[]).filter(c=>!handled.has(c)),...[...handled].filter(c=>kept.has(c))])];
  // A commit with a dependent that got neither a keeper nor its shared name: its object
  // was already gone when this mechanism first reached it (deleted before the upgrade).
  const lost=(sent.keep??[]).filter(c=>!kept.has(c)&&!pinned.has(c));
  // Plain re-pins only; a restoration that did not complete keeps its keeper and is retried.
  const missingPins=sent.pins?.length&&!sent.release_keepers?.length?sent.pins.filter(c=>!pinned.has(c)):[];
  const unrestored=(sent.release_keepers??[]).filter(c=>kept.has(c));
  const {inflight:_,keepers:_k,...rest}=current;
  // Shared refs the claim kept back left the list then, whatever happened later; an owned
  // page's retained refs are counted again when a cancelled page is inspected anew.
  const counted=(current.retained_count??0)+(cancelled?(op.owned_after===undefined?op.shared_retained??0:0):(op.shared_retained??0)+finalRetained);
  // A protection that did not complete is never finished: the missing pins stay
  // claimed (a fresh id; the old one replays its result) and the resource fails visibly.
  const repin=[...new Set([...pins,...missingPins])];
  const updated:WorkspaceCleanupResource={...rest,...(keepers.length?{keepers}:{}),release_refs:list,retained_count:counted,...(!cancelled&&r.kind==='ref_pages'&&op.owned_after!==undefined?{owned_after:op.owned_after}:{}),
   ...(repin.length?{inflight:{operation_id:randomUUID(),refs:[],sources:[],pins:repin,fence:FENCE_VERSION}}:{}),
   // This end's own outcome, never an earlier attempt's error.
   error:lost.length?'workspace_source_lost_before_fence':missingPins.length||unrestored.length?'workspace_source_repin_missing':null,...(lost.length?{lost_sources:lost}:{})};
  await write(tx,w,key,updated);
  return updated;
 });
 if(!outcome)return {skipped:true};
 if(outcome.error==='workspace_source_lost_before_fence'){
  // Irrecoverable before this mechanism reached it: visible, never retried into `cleaned`.
  await save({...outcome,state:'blocked',attempts:next.attempts,blocked_host_level:w.host_reclaim??0,next_retry_at:null} as WorkspaceCleanupResource);
  return {cleanup_state:'blocked'};
 }
 if(!outcome.inflight&&outcome.error==='workspace_source_repin_missing'){
  // A shared name not restored: its keeper stays (the object is safe) and the restoration is retried, then blocks visibly.
  const state=next.attempts>=8?'blocked':'retry_wait';
  const updated={...outcome,state,attempts:next.attempts,next_retry_at:state==='retry_wait'?new Date(Date.now()+Math.min(3600000,30000*2**next.attempts)).toISOString():null} as WorkspaceCleanupResource;
  await save(updated);
  if(state==='retry_wait')throw new JobDeferredError(updated.error!,new Date(updated.next_retry_at!).getTime()-Date.now());
  return {cleanup_state:state};
 }
 if(outcome.inflight&&outcome.error==='workspace_source_repin_missing'){
  const state=next.attempts>=8?'blocked':'retry_wait';
  const updated={...outcome,state,attempts:next.attempts,next_retry_at:state==='retry_wait'?new Date(Date.now()+Math.min(3600000,30000*2**next.attempts)).toISOString():null} as WorkspaceCleanupResource;
  await save(updated);
  if(state==='retry_wait')throw new JobDeferredError(updated.error!,new Date(updated.next_retry_at!).getTime()-Date.now());
  return {cleanup_state:state};
 }
 if(outcome.inflight)return page('workspace_source_repin');
 if(failed){
  const state=next.attempts>=8?'blocked':'retry_wait';
  const updated={...outcome,state,attempts:next.attempts,error:'workspace_refs_release_failed',next_retry_at:state==='retry_wait'?new Date(Date.now()+Math.min(3600000,30000*2**next.attempts)).toISOString():null} as WorkspaceCleanupResource;
  await save(updated);
  if(state==='retry_wait')throw new JobDeferredError(updated.error!,new Date(updated.next_retry_at!).getTime()-Date.now());
  return {cleanup_state:state};
 }
 if(cancelled){
  // Nothing of the cancelled operation is bookkept: its refs are claimed again, fenced.
  await save({...outcome,state:'retry_wait',attempts:0,error:null,next_retry_at:new Date(Date.now()+1000).toISOString()});
  return page('workspace_ref_operation_settled');
 }
 const now=Date.now();
 const dueLeft=(outcome.release_refs??[]).filter(x=>dueOf(x)<=now);
 const later=(outcome.release_refs??[]).filter(x=>dueOf(x)>now);
 const morePages=r.kind==='ref_pages'&&typeof outcome.owned_after==='string';
 if(dueLeft.length||morePages||outcome.history_scan){
  // More pages: progress is persisted; come straight back. Never reported finished early.
  await save({...outcome,state:'retry_wait',attempts:0,error:null,next_retry_at:new Date(now+1000).toISOString()});
  return page('workspace_refs_next_page');
 }
 if(later.length){
  // Items not yet due wait for the earliest of their own due times.
  const at=Math.min(...later.map(dueOf));
  await save({...outcome,state:'pending',attempts:0,error:null,next_retry_at:new Date(at).toISOString()});
  throw new JobDeferredError('workspace_refs_not_due',Math.max(1000,at-now));
 }
 if(outcome.keepers?.length){
  // Keepers whose shared name another unended operation still fences: this
  // resource owns them and is not finished until it restored and dropped each.
  const ready=await withQueryableTransaction(db,async tx=>{
   await lockSourceCommits(tx,w.execution_host_id,outcome.keepers!);
   const fencedNow=await sourcesFencedByOthers(tx,w.execution_host_id,outcome.keepers!);
   return outcome.keepers!.some(c=>!fencedNow.has(c));
  });
  const ms=ready?1000:60_000;
  await save({...outcome,state:'retry_wait',attempts:0,error:null,next_retry_at:new Date(now+ms).toISOString()});
  throw new JobDeferredError(ready?'workspace_source_keeper_restore':'workspace_source_keeper_waiting',ms);
 }
 const kept=outcome.retained_count??0;
 await save({...outcome,state:'cleaned',release_refs:[],owned_after:null,error:null,next_retry_at:null},r.kind!=='ref_pages'?undefined:async tx=>{
  // Only the release this page run belongs to may finish it: the same epoch
  // and release id, still `reclaiming`. A newer release (or launch) keeps its own state.
  const row=(await tx.query<{state:string|null;epoch:string|null;release_id:string|null}>("SELECT retention_json->>'state' AS state,retention_json->>'release_epoch' AS epoch,retention_json->>'release_id' AS release_id FROM execution_workspaces WHERE id=$1 FOR UPDATE",[w.id])).rows[0];
  const own=row?.state==='reclaiming'&&sameRelease(row,r.release_epoch,r.release_id);
  // The last page finishes the release with its real outcome, never a lingering `releasing_refs`.
  if(own)await recordRetention(tx,w.id,{state:'reclaimed',reason:r.reason_on_finish??'no_changes',reclaimed_at:new Date().toISOString(),retained_refs:kept,reclaim_requested_at:null});
  else if(sameRelease(row,r.release_epoch,r.release_id))await recordRetention(tx,w.id,{retained_refs:kept});
 });
 return {cleanup_state:'cleaned'};
}

/** Paused for a Host below the needed level: no attempt spent, the inflight claim and its fence kept. */
async function hostUpgradeWait(r:WorkspaceCleanupResource,save:Save,level:number):Promise<never>{
 await save({...r,state:'retry_wait',error:'host_upgrade_required',blocked_host_level:undefined,required_host_level:level,next_retry_at:new Date(Date.now()+HOST_UPGRADE_WAIT_MS).toISOString()} as WorkspaceCleanupResource);
 throw new JobDeferredError('host_upgrade_required',HOST_UPGRADE_WAIT_MS);
}

/**
 * The visible retention belongs to exactly this release: epoch and release id
 * both match. A retention recorded before release identities existed only
 * matches a page run that has none either.
 */
export function sameRelease(row:{epoch:string|null;release_id:string|null}|undefined,epoch:number|undefined,releaseId:string|undefined){
 if(!row)return false;
 if(row.epoch===null&&row.release_id===null)return epoch===undefined||releaseId===undefined;
 return epoch!==undefined&&row.epoch===String(epoch)&&row.release_id===(releaseId??null);
}
