import type {Queryable} from '../routeUtils/common.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';

/**
 * The durable fence between a shared `refs/rainver/sources/<commit>` deletion
 * and every new dependent of that commit on the same Host.
 *
 * - The claim (inside its short transaction, before any Host request) takes the
 *   per-(Host, commit) advisory lock, proves the commit free of dependents and
 *   inserts a `workspace_source_releases` row carrying its Host operation id.
 * - Every writer of a dependent row (`task_merges`, `workspace_change_sets`:
 *   batches, launches, checkpoints, submitted commits, integrations,
 *   resolutions, delegated adoptions) passes the `workspace_source_release_fence`
 *   trigger (migration 0019). It takes the same lock and is refused while a row
 *   exists, so no dependency can take effect between the claim and the proven
 *   end of the Host deletion — through timeouts, disconnects, lost replies or a
 *   server restart (the row and the inflight operation are both durable).
 * - Only the proven end of that exact operation id removes the rows, in the
 *   transaction that clears the inflight operation: its confirmation, or a
 *   settle reply (reclaim 3) reporting it finished or cancelled for good.
 * - One row per (Host, commit, operation): a commit several pre-fence
 *   operations claimed stays fenced until every one of them ended, and a
 *   re-pin of the shared name is issued only once none is left.
 */
const lockKey=(hostId:string,commit:string)=>`workspace-source-release:${hostId}:${commit}`;

/** Lock in a stable order (the trigger uses the same order for one row's commits). */
export async function lockSourceCommits(tx:Queryable,hostId:string,commits:readonly string[]){
 for(const commit of [...new Set(commits)].sort())await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey(hostId,commit)]);
}

/**
 * Record deletion intents (caller holds the commits' locks); returns the
 * commits this operation now fences. A commit another unended operation
 * already fences is handed to it: never two new deletions of one ref at once.
 */
export async function claimSourceDeletions(tx:Queryable,w:{hostId:string;workspaceId:string;generation:number},operationId:string,commits:readonly string[]):Promise<Set<string>>{
 const list=[...new Set(commits)];
 if(!list.length)return new Set();
 const rows=(await tx.query<{commit:string}>(`INSERT INTO workspace_source_releases(host_id,commit,workspace_id,generation,operation_id)
   SELECT $1::varchar,c,$2::varchar,$3::integer,$4::varchar FROM unnest($5::text[]) c
   WHERE NOT EXISTS(SELECT 1 FROM workspace_source_releases r WHERE r.host_id=$1::varchar AND r.commit=c AND r.operation_id<>$4::varchar)
   ON CONFLICT DO NOTHING RETURNING commit`,[w.hostId,w.workspaceId,w.generation,operationId,list])).rows;
 const own=(await tx.query<{commit:string}>('SELECT commit FROM workspace_source_releases WHERE host_id=$1 AND operation_id=$2 AND commit=ANY($3::text[])',[w.hostId,operationId,list])).rows;
 return new Set([...rows,...own].map(r=>r.commit));
}

/**
 * Make sure an earlier (pre-fence) operation fences every commit it may delete:
 * one row per (Host, commit, operation), added beside any other operation's.
 * Caller holds the commits' locks.
 */
export async function keepSourceDeletionIntents(tx:Queryable,w:{hostId:string;workspaceId:string;generation:number},operationId:string,commits:readonly string[]){
 const list=[...new Set(commits)];
 if(!list.length)return;
 await tx.query(`INSERT INTO workspace_source_releases(host_id,commit,workspace_id,generation,operation_id)
   SELECT $1::varchar,c,$2::varchar,$3::integer,$4::varchar FROM unnest($5::text[]) c ON CONFLICT DO NOTHING`,[w.hostId,w.workspaceId,w.generation,operationId,list]);
}
/** Of `commits`, those an unended operation other than `except` still fences on this Host. Caller holds the locks. */
export async function sourcesFencedByOthers(tx:Queryable,hostId:string,commits:readonly string[],except:readonly string[]=[]):Promise<Set<string>>{
 const list=[...new Set(commits)];
 if(!list.length)return new Set();
 return new Set((await tx.query<{commit:string}>('SELECT DISTINCT commit FROM workspace_source_releases WHERE host_id=$1 AND commit=ANY($2::text[]) AND NOT (operation_id=ANY($3::text[]))',[hostId,list,[...except]])).rows.map(r=>r.commit));
}

/**
 * The proven end of a Host operation (confirmed, or cancelled for good by a
 * settle): its intents stop fencing writers. Call with the commits' locks held.
 * Returns the commits no other unended operation still fences: only for those
 * may a protection (a re-pin of the same shared name) be issued, since no
 * deletion of that ref can run any more.
 */
export async function clearSourceDeletions(tx:Queryable,operationId:string,hostId?:string,commits:readonly string[]=[]):Promise<Set<string>>{
 await tx.query('DELETE FROM workspace_source_releases WHERE operation_id=$1',[operationId]);
 if(!hostId||!commits.length)return new Set();
 const fenced=new Set((await tx.query<{commit:string}>('SELECT DISTINCT commit FROM workspace_source_releases WHERE host_id=$1 AND commit=ANY($2::text[])',[hostId,[...new Set(commits)]])).rows.map(r=>r.commit));
 return new Set(commits.filter(c=>!fenced.has(c)));
}

/** The trigger's refusal: a dependent waits for the deletion's confirmation, it is never a failure. */
export function isSourceReleasePending(error:unknown):boolean{
 return /workspace_source_release_pending/.test(error instanceof Error?error.message:String(error));
}
/** Rethrow the fence's refusal as a Job deferral (no attempt spent, no failure state recorded). */
export function deferIfSourceReleasePending(error:unknown,ms=15_000){
 if(isSourceReleasePending(error))throw new JobDeferredError('workspace_source_release_pending',ms);
}

/**
 * For a writer that holds a lock the deletion's confirmation needs (a Run
 * start holds the workspace row): the trigger refuses at once instead of
 * waiting inside the transaction (`SET LOCAL` wait 0), the transaction rolls
 * back and releases its locks, and the whole unit is retried after a pause
 * outside any transaction, so the confirmation can commit meanwhile. Past the
 * bound the refusal propagates as the retryable `workspace_source_release_pending`.
 */
export async function retryOutsideSourceFence<T>(unit:()=>Promise<T>,options:{boundMs?:number;pauseMs?:number}={}):Promise<T>{
 const until=Date.now()+(options.boundMs??120_000);
 for(let pause=options.pauseMs??200;;pause=Math.min(pause*2,5000)){
  try{return await unit();}
  catch(error){
   if(!isSourceReleasePending(error)||Date.now()+pause>until)throw error;
   await new Promise(resolve=>setTimeout(resolve,pause));
  }
 }
}
/** Inside the writer's transaction: refuse at once rather than wait while holding its locks. */
export async function refuseSourceFenceWithoutWaiting(tx:Queryable){
 await tx.query("SELECT set_config('rainver.source_release_wait_ms','0',true)");
}
