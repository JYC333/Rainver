import {randomUUID} from 'node:crypto';
import type {Pool} from '../../db/pool.js';
import {reconcileExecutionWorkspaces} from './workspaceReconcile.js';
import {workspaceProfileFrame} from './workspaceLocation.js';
import {workspaceReference,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {sharedHostConnectionRegistry,type ManagedWorkspaceResult} from './connectionRegistry.js';
import {PgHostThreadRepository} from './threadRepository.js';
import {archiveOperationId,classifyManagedWorkspaceResult,drainUnfencedArchives,HOST_UPDATE_REQUIRED,hostDrainsLegacyArchives,hostJournalsManagedWorkspaceOperations,hostJournalsWorkspaceProfileArchives,markArchiveUnfenced,pendingArchiveIntent,releaseUnfencedArchives,sendPendingManagedWorkspaceArchive} from './managedWorkspaceOperations.js';
import type {Queryable} from '../routeUtils/common.js';

type ArchiveHosts = Pick<typeof sharedHostConnectionRegistry, 'requestManagedWorkspaceAction'|'requestTaskBranch'|'drainLegacyManagedWorkspaceArchives'>;
type PendingArchive = Awaited<ReturnType<PgHostThreadRepository['listPendingManagedWorkspaceArchives']>>[number];

/**
 * Sends one pending archive the way it is owed. A thread whose runs used an
 * isolated execution workspace keeps its profile under that workspace, so its
 * archive is the workspace command's `archive_profiles`; any other is the
 * journaled managed-workspace operation, repeated under its one identity.
 * `owed: false` means nothing is owed on this Host for it any more.
 */
async function sendPendingArchive(pool:Queryable,hostId:string,item:PendingArchive,hosts:ArchiveHosts):Promise<ManagedWorkspaceResult&{settled:boolean;owed:boolean}>{
  if(item.execution_workspace_json&&item.space_id){
    const ref=item.execution_workspace_json;
    const w=(await pool.query<ExecutionWorkspaceRow & {archive_actor_id:string}>(`SELECT w.*,t.created_by_user_id AS archive_actor_id FROM execution_workspaces w
      JOIN host_threads t ON t.id=$5 AND t.execution_host_id=w.execution_host_id AND t.agent_id=$6
      WHERE w.id=$1 AND w.space_id=$2 AND w.generation=$3 AND w.execution_host_id=$4
       AND t.status='closed' AND t.pending_archive_at IS NOT NULL
       AND t.execution_workspace_json->>'id'=w.id AND t.execution_workspace_json->>'generation'=w.generation::text`,[ref.id,item.space_id,ref.generation,hostId,item.id,item.agent_id])).rows[0];
    if(!w)return {ok:true,changed:false,error:null,settled:false,owed:false};
    const intent=await pendingArchiveIntent(pool,item.id);
    if(!intent)return {ok:true,changed:false,error:null,settled:true,owed:false};
    // The thread's one archive operation, journaled per Agent on a Host that can: every send — after-commit,
    // recovery, a launch barrier — is the same receipt, and a late copy is refused by the Host's fence.
    const journaled=await hostJournalsWorkspaceProfileArchives(pool,hostId);
    if(!journaled)await markArchiveUnfenced(pool,item.id);
    const result=await hosts.requestTaskBranch(hostId,'execution_workspace_command',{
      workspace:await workspaceProfileFrame(pool,w,{...workspaceReference(w),...(ref.profile_container_id&&ref.profile_container_id!==ref.id?{integration_id:ref.profile_container_id}:{})},w.archive_actor_id),
      action:'archive_profiles',operation_id:randomUUID(),profile_agents:[item.agent_id],retain_branch:true,
      ...(journaled?{archive_identity:{operation_id:archiveOperationId(item.id,intent.generation),generation:intent.generation}}:{})});
    const code=(result as {error_code?:ManagedWorkspaceResult['error_code']}).error_code;
    const settled=result.ok||code==='stale_generation';
    if(settled)await new PgHostThreadRepository(pool).acknowledgeManagedWorkspaceArchive(item.id,intent.generation);
    const answer={ok:result.ok,changed:result.ok,error:result.error??null,...(code?{error_code:code}:{})};
    return {...answer,settled,owed:!settled&&classifyManagedWorkspaceResult(answer)==='retry'};
  }
  // The same operation every time: a lost reply, a duplicate send or a late delivery cannot archive twice or undo a newer restore.
  const result=await sendPendingManagedWorkspaceArchive(pool,item.id,{
    hostId,agentId:item.agent_id,containerKind:item.container_kind,containerId:item.container_id,
  },hosts);
  return {...result,owed:!result.settled&&classifyManagedWorkspaceResult(result)==='retry'};
}

/** One Host's committed archive intents (`pending_archive_at`), retried until acknowledged. */
export async function reconcilePendingManagedWorkspaceArchives(pool: Pool, hostId: string,workspaceRoot?:string): Promise<void> {
  const failures:unknown[]=[];
  // Reconciliation and profile archival are independent recoveries. An invalid
  // Location may fail its inventory without preventing other caches retiring.
  if(workspaceRoot){
    try{const result=await reconcileExecutionWorkspaces(pool,workspaceRoot,{hostId});failures.push(...result.failures);}
    catch(error){failures.push(error);}
  }
  const pending = await new PgHostThreadRepository(pool).listPendingManagedWorkspaceArchives(hostId);
  for (const item of pending) {
    try{await sendPendingArchive(pool,hostId,item,sharedHostConnectionRegistry);}catch(error){failures.push(error);}
  }
  if(failures.length)throw new AggregateError(failures,'Host workspace recovery needs attention');
}

/** A profile container a Run's runtime is about to use: `agents/<agent>/profiles/<kind>/<id>` on its Host. */
export interface LaunchProfileTarget { agent_id:string; container_kind:string; container_id:string }

/**
 * Before a Run's runtime is started on a Host, every archive still owed for
 * the very profile directory it will use is settled — whichever mode the
 * Conversation runs in (managed cwd, a registered Location, an isolated
 * workspace) and whether or not that archive also takes a cwd. An Agent that
 * left (its profile archive committed) and was re-added without a restore
 * starts in that same directory; an archive landing after the new Run began
 * would move the new Run's profile away under it. Settled first, no earlier
 * intent for it can still move anything: a repeat of a journaled one replays
 * its receipt, and the Host refuses a late copy older than what it applied.
 *
 * Only this Agent's own profile target is touched; another Agent's profile is
 * never archived here, and the shared cwd keeps its own barrier
 * (`settleConversationCwdArchives`). An owed archive that is unconfirmed —
 * offline, a lost reply, an interrupted move — is returned, and the caller
 * refuses the launch; the next turn repeats the same operation. A Host that
 * cannot journal or fence the managed operation refuses the launch while one
 * is owed: a late copy of a legacy archive cannot be told from a new one.
 */
export async function settleLaunchProfileArchives(pool:Queryable,hostId:string,target:LaunchProfileTarget,hosts:ArchiveHosts=sharedHostConnectionRegistry):Promise<ManagedWorkspaceResult>{
  const rows=(await new PgHostThreadRepository(pool).listPendingManagedWorkspaceArchives(hostId,target.agent_id,true))
    .filter(item=>target.container_kind==='workspace'
      ?Boolean(item.execution_workspace_json&&item.space_id)&&(item.execution_workspace_json!.profile_container_id??item.execution_workspace_json!.id)===target.container_id
      :!(item.execution_workspace_json&&item.space_id)&&item.container_kind===target.container_kind&&item.container_id===target.container_id);
  const fencing=target.container_kind==='workspace'?'workspace' as const:'managed' as const;
  const cleanup=await settleCleanupProfileArchives(pool,hostId,target,hosts);
  if(!cleanup.ok)return cleanup;
  // An archive once sent without an identity may still be in flight, whatever acknowledged it since: the Host drains it.
  const released=await releaseUnfencedArchives(pool,hostId,rows.filter(item=>item.unfenced).map(item=>item.id),hosts);
  if(!released.ok)return released;
  const owed=rows.filter(item=>item.pending);
  if(!owed.length)return {ok:true,changed:false,error:null};
  const journaled=fencing==='workspace'?await hostJournalsWorkspaceProfileArchives(pool,hostId):await hostJournalsManagedWorkspaceOperations(pool,hostId);
  if(!journaled)return {ok:false,changed:false,error:HOST_UPDATE_REQUIRED};
  for(const item of owed){
    const result=await sendPendingArchive(pool,hostId,item,hosts);
    if(result.owed)return {ok:false,changed:false,error:result.error??'archive_unconfirmed',...(result.error_code?{error_code:result.error_code}:{})};
  }
  return {ok:true,changed:false,error:null};
}

/**
 * The workspace cleanup Job's profile archives aimed at this exact profile: a
 * cutover's legacy Conversation profile, or a retired workspace's profiles.
 * One sent (its identity fixed, or sent unfenced) and not yet done may still
 * land, and the Job will send it again: the launch waits for the Job to settle
 * it, however it was sent. One ever sent unfenced keeps the launch refused on
 * a Host that cannot drain identity-less archives, and once done is released
 * only by the Host's drain — never by a capability or a reconnect.
 */
async function settleCleanupProfileArchives(pool:Queryable,hostId:string,target:LaunchProfileTarget,hosts:ArchiveHosts):Promise<ManagedWorkspaceResult>{
  if(target.container_kind!=='conversation'&&target.container_kind!=='workspace')return {ok:true,changed:false,error:null};
  const rows=(await pool.query<{workspace_id:string;key:string;done:boolean;sent:boolean;unfenced:boolean}>(
    `SELECT w.id AS workspace_id,r.key,
            CASE WHEN r.value->>'kind'='legacy_profiles' THEN r.value->>'state'='cleaned' ELSE COALESCE((r.value->>'profiles_archived')::boolean,false) END AS done,
            (r.value ? 'archive_generation' OR COALESCE((r.value->>'sent_unfenced')::boolean,false)) AS sent,
            COALESCE((r.value->>'sent_unfenced')::boolean,false) AS unfenced
       FROM execution_workspaces w CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(w.cleanup_json)='object' THEN w.cleanup_json ELSE '{}'::jsonb END) r
      WHERE w.execution_host_id=$1 AND (
        ($2='conversation' AND r.value->>'kind'='legacy_profiles' AND r.value->>'legacy_agent_id'=$3 AND r.value->>'legacy_container_id'=$4)
        OR ($2='workspace' AND r.value->'profile_agents' ? $3
            AND COALESCE(r.value->'workspace'->>'integration_id',r.value->'workspace'->>'id')=$4))`,
    [hostId,target.container_kind,target.agent_id,target.container_id])).rows;
  const unfenced=rows.filter(row=>row.unfenced);
  if(unfenced.length&&!await hostDrainsLegacyArchives(pool,hostId))return {ok:false,changed:false,error:HOST_UPDATE_REQUIRED};
  if(rows.some(row=>row.sent&&!row.done))return {ok:false,changed:false,error:'workspace_cleanup_profile_archive_unconfirmed'};
  if(unfenced.length){
    const drained=await drainUnfencedArchives(pool,hostId,hosts);
    if(!drained.ok)return drained.result;
    // Every identity-less copy has finished and none can start: the done resource no longer holds the launch.
    for(const row of unfenced)await pool.query(
      `UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2,'sent_unfenced'],'false'::jsonb),updated_at=now() WHERE id=$1 AND cleanup_json ? $2`,
      [row.workspace_id,row.key]);
  }
  return {ok:true,changed:false,error:null};
}

/** A pending archive this old missed its after-commit attempt; the connected Host still owes it. */
const ARCHIVE_RETRY_AFTER_MS = 2 * 60_000;

/**
 * Archive intents are retried when their Host reconnects, and here for Hosts
 * that stayed connected while the first attempt failed or never ran (the
 * committing process stopped first). Acknowledged rows stop being retried.
 */
export async function retryPendingArchivesForConnectedHosts(pool:Pool):Promise<number>{
  const hosts=await pool.query<{execution_host_id:string}>(
    `SELECT DISTINCT execution_host_id FROM host_threads
      WHERE status='closed' AND pending_archive_at IS NOT NULL AND execution_host_id IS NOT NULL
        AND pending_archive_at < now() - ($1::int * interval '1 millisecond')`,[ARCHIVE_RETRY_AFTER_MS]);
  let retried=0;
  for(const {execution_host_id:hostId} of hosts.rows){
    if(!sharedHostConnectionRegistry.isOnline(hostId))continue;
    await reconcilePendingManagedWorkspaceArchives(pool,hostId);
    retried++;
  }
  return retried;
}
