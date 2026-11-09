import {closeEndedNativeWorkspaceRequests} from './workspaceNativeIntegration.js';
import {workspaceHostFailureIsTemporary,workspaceCheckpointRunSettledSql,WORKSPACE_TEMPORARY_HOST_ERRORS} from '../projectFolders/workspacePolicy.js';
import {randomUUID} from 'node:crypto';
import type {Queryable} from '../routeUtils/common.js';
import {withQueryableTransaction} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from './connectionRegistry.js';
import {enqueueWorkspaceCleanup,refreshCleanupSummary,replaceableSourceCleanup,type WorkspaceCleanupResource} from './workspaceCleanup.js';
import {workspaceLocationFrame} from './workspaceLocation.js';
import {workspaceReference,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {canWriteProject} from '../projects/access.js';
import {assessWorkspaceRetention,classifyLocationRefs,hostReleasesRefs,recordRetention,RECLAIM_PROTOCOL} from './workspaceRetention.js';
import {CONFIRMED_REF_FAILURES,requiredRefLevel} from './workspaceRefRelease.js';
import {reconcilePublishedWorkspaceChild} from './workspaceAdoption.js';

/** Bounded database reconciliation. It repairs intent delivery, never invents completion. */
export async function reconcileExecutionWorkspaces(db:Queryable,workspaceRoot:string,options:{hostId?:string;after?:string;hosts?:HostConnectionRegistry}={}){
 const hosts=options.hosts??sharedHostConnectionRegistry;
 const rows=(await db.query<ExecutionWorkspaceRow & {cleanup_json:Record<string,WorkspaceCleanupResource>;inventory_json:Record<string,unknown>;responsible_user:string|null;host_owner:string|null;host_kind:string;idle:boolean;closed_owner:boolean;host_reclaim:number|null}>(`SELECT w.*,h.kind AS host_kind,h.owner_user_id AS host_owner,(h.capabilities_json->'execution_workspaces'->>'reclaim')::int AS host_reclaim,
  (SELECT COALESCE(r.instructed_by_user_id,r.owner_user_id) FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=w.id ORDER BY b.created_at DESC LIMIT 1) AS responsible_user,
  w.updated_at<now()-interval '24 hours' AS idle,
  CASE WHEN w.owner_kind='delegation' THEN EXISTS(SELECT 1 FROM run_delegations d WHERE d.id=w.delegation_id AND d.completed_at IS NOT NULL)
   ELSE EXISTS(SELECT 1 FROM sessions s WHERE s.id=w.session_id AND s.status IN ('closed','archived')) END AS closed_owner
  FROM execution_workspaces w JOIN hosts h ON h.id=w.execution_host_id
  WHERE ($1::varchar IS NULL OR w.execution_host_id=$1) AND ($2::varchar IS NULL OR w.id>$2)
   AND (w.state<>'retired' OR (COALESCE(w.retention_json->>'state','')<>'reclaimed' AND COALESCE((w.retention_json->>'assessed_at')::timestamptz,'-infinity')<now()-interval '1 hour') OR EXISTS(SELECT 1 FROM jsonb_each(w.cleanup_json) resource
    WHERE resource.value->>'state' IN ('pending','running','retry_wait')
     OR (resource.value->>'state'='blocked' AND regexp_replace(COALESCE(resource.value->>'error',''),'^Error: ','')=ANY($3::text[]))
     -- Ref work blocked against an older Host protocol, now that the Host reports a newer one
     -- (whether it is the level that work needs is decided per resource below).
     OR (resource.value->>'state'='blocked' AND resource.value->>'kind' IN ('ref_pages','local_preimages','run_history')
      AND COALESCE((resource.value->>'blocked_host_level')::int,0)<GREATEST($4,COALESCE((h.capabilities_json->'execution_workspaces'->>'reclaim')::int,0))
      AND COALESCE((h.capabilities_json->'execution_workspaces'->>'reclaim')::int,0)>=$4))) ORDER BY w.id LIMIT 50`,[options.hostId??null,options.after??null,WORKSPACE_TEMPORARY_HOST_ERRORS,RECLAIM_PROTOCOL])).rows;
 let recovered=0;
 const failures:Array<{workspace_id:string;error:string}>=[];
 for(const w of rows){
  try{
  const user=w.responsible_user;
  if(!user||w.host_kind==='remote'&&w.host_owner!==user||!await canWriteProject(db,w.space_id,w.project_id,user))continue;
  await withQueryableTransaction(db,async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`workspace-reconcile:${w.id}`]);
   if(w.state!=='retired'){
   await closeEndedNativeWorkspaceRequests(tx,w.id);
   const candidates=(await tx.query<{type:string;key:string;payload:Record<string,unknown>}>(`SELECT 'execution_workspace_checkpoint' AS type,b.run_id AS key,(jsonb_build_object('workspace_id',b.workspace_id,'run_id',b.run_id)||CASE WHEN COALESCE(c.verification_json->'checkpoint_recovery'->>'request_id','')<>'' THEN jsonb_build_object('checkpoint_recovery_id',c.verification_json->'checkpoint_recovery'->>'request_id') ELSE '{}'::jsonb END) AS payload FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id JOIN workspace_change_sets c ON c.id=b.change_set_id WHERE b.workspace_id=$1 AND b.checkpoint_state='pending' AND COALESCE(c.verification_json->'checkpoint_recovery'->>'state','')<>'exhausted' AND ${workspaceCheckpointRunSettledSql('r')}
    UNION ALL SELECT 'execution_workspace_complete',c.id,jsonb_build_object('change_set_id',c.id) FROM workspace_change_sets c WHERE c.workspace_id=$1 AND c.state='ready'
    UNION ALL SELECT 'task_merge',m.id,jsonb_build_object('merge_id',m.id,'workspace_id',m.workspace_id) FROM task_merges m WHERE m.workspace_id=$1 AND m.status IN ('queued','rebasing','resolving','verifying','waiting_local_changes') AND COALESCE(m.detail_json->>'native_integration','false')<>'true'
    UNION ALL SELECT 'execution_workspace_native_integrate',c.id,jsonb_build_object('change_set_id',c.id,'request_id',c.verification_json->'native_request'->>'id') FROM workspace_change_sets c WHERE c.workspace_id=$1 AND c.state IN ('open','integrating') AND c.verification_json->'native_progress'->>'status'='pending'`,[w.id])).rows;
   for(const candidate of candidates){
    const active=(await tx.query(`SELECT 1 FROM jobs WHERE job_type=$1 AND status IN ('pending','claimed','running') AND payload_json @> $2::jsonb LIMIT 1`,[candidate.type,JSON.stringify(candidate.payload)])).rowCount;
    if(!active){await new PgJobQueueRepository(tx).enqueue({job_type:candidate.type,space_id:w.space_id,user_id:user,payload:candidate.payload});recovered++;}
   }
   }
   for(const [key,r] of Object.entries(w.cleanup_json??{})){
    // Restores act on the resource as it is now, never on this scan's copy: a
    // Job of the same operation may have advanced it (confirmed, re-claimed,
    // moved to a re-pin) since. Re-read under the row lock, re-check the pause
    // conditions and the Host's current level, and restore from that value.
    const resumable=oldProtocolRefWork(r)||r.state==='blocked'&&r.workspace.id===w.id&&r.workspace.generation===w.generation&&workspaceHostFailureIsTemporary(r.error?.replace(/^Error: /,''));
    if(resumable){
     const current=(await tx.query<{resource:WorkspaceCleanupResource|null;level:number|null}>(`SELECT w.cleanup_json->$2 AS resource,(h.capabilities_json->'execution_workspaces'->>'reclaim')::int AS level
      FROM execution_workspaces w JOIN hosts h ON h.id=w.execution_host_id WHERE w.id=$1 FOR UPDATE OF w`,[w.id,key])).rows[0];
     const latest=current?.resource;
     if(!latest||latest.operation_id!==r.operation_id)continue;
     // Ref work paused for (or exhausted against) a Host below the level its
     // next step needs resumes once the Host reports it. An unfenced deletion
     // is then settled first (never re-sent); a fenced one is re-sent unchanged.
     const upgraded=oldProtocolRefWork(latest)&&(current!.level??0)>=requiredRefLevel(latest);
     // Manifests exhausted by the old transport-failure accounting. Keep
     // capture/profile evidence and fence any old Job with a new operation id.
     const transient=latest.state==='blocked'&&latest.workspace.id===w.id&&latest.workspace.generation===w.generation&&workspaceHostFailureIsTemporary(latest.error?.replace(/^Error: /,''));
     if(upgraded||transient){
      const {blocked_host_level:_b,required_host_level:_r,...rest}=latest;
      const restored={...rest,state:'pending' as const,attempts:0,error:null,next_retry_at:null,operation_id:randomUUID()};
      await tx.query("UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1",[w.id,key,JSON.stringify(restored)]);
      await refreshCleanupSummary(tx,w.id);
      await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:user,payload:{workspace_id:w.id,resource_key:key,operation_id:restored.operation_id}});recovered++;
      continue;
     }
     if(r.state==='blocked')continue;
    }
    if(!['pending','running','retry_wait'].includes(r.state))continue;
    const payload={workspace_id:w.id,resource_key:key,operation_id:r.operation_id};
    if(!(await tx.query(`SELECT 1 FROM jobs WHERE job_type='execution_workspace_cleanup' AND status IN ('pending','claimed','running') AND payload_json @> $1::jsonb LIMIT 1`,[JSON.stringify(payload)])).rowCount){
     await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:user,payload,scheduled_at:r.next_retry_at?new Date(r.next_retry_at):undefined});recovered++;
    }
   }
  });
  if(!hosts.isOnline(w.execution_host_id))continue;
  if(await reconcilePublishedWorkspaceChild(db,w,user,hosts,workspaceRoot))recovered++;
  // Retention: a proven-closed source (retired or not) is offered for release
  // after its grace. The cleanup Job re-assesses, observes the tip and lets the
  // Host prove it; offline Hosts simply wait for reconnect.
  await offerRetention(db,w,user);
  // A retired owner can deliver its already-recorded cleanup only. It never
  // refreshes executable state, creates checkpoints, or reopens a vendor session.
  if(w.state==='retired')continue;
  const active=(await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=$1 AND (b.checkpoint_state<>'saved' OR r.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review')) LIMIT 1`,[w.id])).rowCount;
  if(active)continue;
  const inspection=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:await workspaceLocationFrame(db,w,workspaceReference(w),workspaceRoot),action:'inspect',operation_id:randomUUID(),retain_branch:true});
  if(!inspection.ok||!inspection.inventory)continue;
  await db.query('UPDATE execution_workspaces SET inventory_json=$2::jsonb WHERE id=$1',[w.id,JSON.stringify(inspection.inventory)]);
  if(w.inventory_json?.reconciliation_error){
   await refreshCleanupSummary(db,w.id);
   if(inspection.inventory.worktree||inspection.inventory.registration||inspection.inventory.run_record||inspection.inventory.merge_record){
    await db.query("UPDATE execution_workspaces SET cleanup_state='pending' WHERE id=$1 AND cleanup_state='cleaned'",[w.id]);
   }
  }
  if(inspection.inventory.quarantined_whole>0)await db.query("UPDATE execution_workspaces SET cleanup_state='blocked' WHERE id=$1",[w.id]);
  await scanLocationRefs(db,w,hosts,workspaceRoot);
  const owed=(await db.query("SELECT 1 FROM workspace_change_sets WHERE workspace_id=$1 AND state IN ('open','ready','integrating','blocked') LIMIT 1",[w.id])).rowCount;
  if((w.idle||w.closed_owner&&!owed)&&inspection.commit&&(inspection.inventory.worktree||inspection.inventory.registration)&&!inspection.inventory.run_record&&!inspection.inventory.active){
   const current=(await db.query<{cleanup_json:Record<string,WorkspaceCleanupResource>}>('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.id])).rows[0]?.cleanup_json?.[`source-g${w.generation}`];
   // Never replace a running request or an issued release (its epoch fences the Host), only an idle or finished one.
   if(replaceableSourceCleanup(current)&&(!current||current.state==='cleaned'||current.expected_commit!==inspection.commit))await enqueueWorkspaceCleanup(db,w,{id:w.id,generation:w.generation},inspection.commit,true,user);
  }
  if(w.closed_owner&&!owed&&!inspection.inventory.active&&!inspection.inventory.worktree&&!inspection.inventory.registration&&!inspection.inventory.run_record&&inspection.inventory.quarantined_whole===0){
   await db.query(`UPDATE host_threads SET status='closed',vendor_session_id=NULL,pending_archive_at=COALESCE(pending_archive_at,now()),updated_at=now() WHERE execution_workspace_json->>'id'=$1 AND status<>'closed'`,[w.id]);
   // The branch is intentionally retained. Retiring the logical owner closes caches.
   await db.query("UPDATE execution_workspaces SET state='retired',updated_at=now() WHERE id=$1",[w.id]);
  }
  }catch(error){
   const message=error instanceof Error?error.message:String(error);
   const reason=/^execution_workspace_[a-z_]+$/.test(message)?message:'workspace_reconciliation_failed';
   failures.push({workspace_id:w.id,error:reason});
   // A retired/archived Location or one broken Host must not strand the scan
   // cursor or independent owners. Keep a durable, path-free attention reason.
   try{
    await db.query(`UPDATE execution_workspaces SET cleanup_state='blocked',
     inventory_json=inventory_json||jsonb_build_object('reconciliation_error',$2::text,'reconciliation_failed_at',now()) WHERE id=$1`,[w.id,reason]);
   }catch{
    failures[failures.length-1]!.error='workspace_reconciliation_persistence_failed';
   }
  }
 }
 return {recovered,next:rows.length===50?rows.at(-1)!.id:undefined,failures};
}

const REFS_SCAN_INTERVAL="interval '6 hours'";
/** Pages (of 500 refs) read per reconciliation pass; a longer scan resumes from its cursor next pass. */
const REFS_SCAN_PAGES_PER_PASS=10;
/** Enqueue (at most one) source cleanup for a reclaimable or grace-period owner. */
async function offerRetention(db:Queryable,w:ExecutionWorkspaceRow & {cleanup_json:Record<string,WorkspaceCleanupResource>;retention_json?:Record<string,unknown>;host_reclaim?:number|null},user:string){
 if(!hostReleasesRefs(w.host_reclaim))return;
 const stored=w.retention_json??{};
 if(stored.state==='reclaimed'||stored.state==='reclaiming')return;
 const assessment=await assessWorkspaceRetention(db,w.id);
 // Persist only a changed (or hour-old) assessment: retained owners stay visible
 // without a write every scan, and retired ones are re-checked hourly.
 const stale=typeof stored.assessed_at!=='string'||Date.parse(stored.assessed_at)<Date.now()-3600_000;
 if(stale||stored.state!==assessment.state||stored.reason!==assessment.reason)await recordRetention(db,w.id,{state:assessment.state,reason:assessment.reason,reclaim_after:assessment.reclaim_after});
 if(assessment.state!=='reclaimable'&&assessment.state!=='grace')return;
 const current=w.cleanup_json?.[`source-g${w.generation}`];
 if(!replaceableSourceCleanup(current))return;
 // When the release is due: now, or at the end of its grace.
 const due=assessment.state==='grace'&&assessment.reclaim_after?Date.parse(assessment.reclaim_after):Date.now();
 // A Job parked on an older timer (the 24-hour idle rule of a then-retained
 // source, or an expired hold) is replaced, which fences it by operation id.
 // One already due within a minute of the release is left alone.
 if(current&&current.state!=='cleaned'){
  const parked=current.next_retry_at?Date.parse(current.next_retry_at):(await db.query<{at:Date}>(`SELECT MIN(scheduled_at) AS at FROM jobs WHERE job_type='execution_workspace_cleanup' AND status='pending' AND payload_json @> $1::jsonb`,[JSON.stringify({workspace_id:w.id,operation_id:current.operation_id})])).rows[0]?.at?.getTime()??Date.now();
  if(parked<=due+60_000)return;
 }
 const tip=w.head_commit??w.base_commit;
 if(!tip)return;
 await enqueueWorkspaceCleanup(db,w,{id:w.id,generation:w.generation},tip,true,user,undefined,undefined,assessment.state==='grace'?new Date(due):'now');
}

/**
 * Bounded, rate-limited Location inventory of refs/rainver/: refs no known
 * workspace, integration or recorded commit can claim are reported, never
 * deleted. The handling entry is documented in the Hosts guide.
 */
async function scanLocationRefs(db:Queryable,w:ExecutionWorkspaceRow & {host_reclaim?:number|null},hosts:HostConnectionRegistry,workspaceRoot:string){
 if(!w.host_reclaim)return;
 const recent=(await db.query(`SELECT 1 FROM execution_workspaces WHERE workspace_location_id=$1 AND (retention_json->>'refs_scanned_at')::timestamptz>now()-${REFS_SCAN_INTERVAL} LIMIT 1`,[w.workspace_location_id])).rowCount;
 if(recent)return;
 // A scan in progress continues from its cursor on every pass; it is only
 // reported complete (refs_scanned_at, counts) after its last page.
 const progress=(await db.query<{after:string|null;count:number;sample:string[]}>(`SELECT retention_json->'refs_scan'->>'after' AS after,COALESCE((retention_json->'refs_scan'->>'count')::int,0) AS count,COALESCE(retention_json->'refs_scan'->'sample','[]'::jsonb) AS sample
  FROM execution_workspaces WHERE workspace_location_id=$1 AND retention_json ? 'refs_scan' ORDER BY id LIMIT 1`,[w.workspace_location_id])).rows[0];
 const frame=await workspaceLocationFrame(db,w,workspaceReference(w),workspaceRoot);
 let after=progress?.after??undefined,count=progress?.count??0,sample=[...(progress?.sample??[])];
 for(let page=0;page<REFS_SCAN_PAGES_PER_PASS;page++){
  const listed=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:frame,action:'list_refs',operation_id:randomUUID(),retain_branch:true,...(after?{list_after:after}:{})});
  if(!listed.ok||!listed.refs)return;
  const unclaimed=await classifyLocationRefs(db,w.execution_host_id,listed.refs);
  count+=unclaimed.length;sample=[...sample,...unclaimed.map(u=>u.ref)].slice(0,5);
  if(listed.refs_next){after=listed.refs_next;continue;}
  await db.query(`UPDATE execution_workspaces SET retention_json=(retention_json-'refs_scan')||jsonb_build_object('refs_scanned_at',now(),'unclaimed_refs',$2::int,'unclaimed_sample',$3::jsonb,'refs_scan_truncated',false) WHERE workspace_location_id=$1`,
   [w.workspace_location_id,count,JSON.stringify(sample)]);
  return;
 }
 await db.query(`UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('refs_scan',jsonb_build_object('after',$2::text,'count',$3::int,'sample',$4::jsonb)) WHERE workspace_location_id=$1`,
  [w.workspace_location_id,after,count,JSON.stringify(sample)]);
}

/** Delayed/paged ref work waiting for, or blocked by, a Host below the level its next step needs. */
function oldProtocolRefWork(r:WorkspaceCleanupResource){
 if(r.kind!=='ref_pages'&&r.kind!=='local_preimages'&&r.kind!=='run_history')return false;
 if(r.state==='retry_wait'&&r.error==='host_upgrade_required')return true;
 return r.state==='blocked'&&!CONFIRMED_REF_FAILURES.has(r.error??'')&&(r.blocked_host_level??0)<requiredRefLevel(r);
}
