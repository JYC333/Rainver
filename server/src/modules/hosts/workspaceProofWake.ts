import type {HostConnectionRegistry} from './connectionRegistry.js';
import {workspaceLocationFrame} from './workspaceLocation.js';
import {workspaceReference,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {canWriteProject} from '../projects/access.js';
import {randomUUID} from 'node:crypto';
import type {Queryable} from '../routeUtils/common.js';
import {withQueryableTransaction} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {WorkspaceCleanupResource} from './workspaceCleanup.js';

/** Observations only wake existing proof work; they never authorize release.
 * Selected independently of the existing 50-owner id scan. Actual deletion still needs the Host's exact Git proof and CAS. */
export async function wakeWorkspaceProofs(db:Queryable,w:{id:string;generation:number;space_id:string},user:string,source:string|null,target:string|null){
 const observation={generation:w.generation,source,target};
 return withQueryableTransaction(db,async tx=>{
  const row=(await tx.query<{retention_json:Record<string,unknown>;cleanup_json:Record<string,WorkspaceCleanupResource>}>(
   'SELECT retention_json,cleanup_json FROM execution_workspaces WHERE id=$1 AND generation=$2 FOR UPDATE',[w.id,w.generation])).rows[0];
  if(!row)return;
  const previous=row.retention_json.proof_observation as Partial<typeof observation>|undefined;
  const changed=previous?.generation!==observation.generation||previous?.source!==source||previous?.target!==target;
  await tx.query(`UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('proof_observed_at',now(),'proof_observation',$2::jsonb) WHERE id=$1`,[w.id,JSON.stringify(observation)]);
  if(!changed)return;
  if(row.retention_json.proof_refused_reason==='unmerged_source')await tx.query(`UPDATE execution_workspaces SET retention_json=retention_json-'proof_refused_tip'-'proof_refused_reason'-'proof_refused_at' WHERE id=$1`,[w.id]);
  for(const [key,r] of Object.entries(row.cleanup_json)){
   // Never supersede an issued operation or an incomplete journal. A proof
   // wait has finished its Host operation and retained the exact release list.
   if(r.kind!=='ref_pages'||r.state!=='retry_wait'||!r.error?.startsWith('checkpoint_not_in_')||r.inflight)continue;
   const next={...r,operation_id:randomUUID(),state:'pending',proof_waits:0,attempts:0,error:null,next_retry_at:null};
   await tx.query('UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1',[w.id,key,JSON.stringify(next)]);
   await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:user,payload:{workspace_id:w.id,resource_key:key,operation_id:next.operation_id}});
  }
 });
}

/** Claim before RPC, including failures. Oldest-first selection provides fairness;
 * each pass probes at most four owners, each at most once per five minutes,
 * independently of the week-long proof refusal backoff. */
export async function claimWorkspaceProofProbe(db:Queryable,id:string){
 return Boolean((await db.query(`UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('proof_probe_at',now())
  WHERE id=$1 AND COALESCE((retention_json->>'proof_probe_at')::timestamptz,'-infinity')<=now()-interval '5 minutes' RETURNING id`,[id])).rowCount);
}


/** Independent of the reconciliation id cursor. Claim oldest/null-first across
 * the whole Host population, so slow rounds cannot repeatedly select a prefix.
 * Claim failures/offline owners too: they cannot monopolize a future round. */
export async function probeWorkspaceProofs(db:Queryable,hosts:HostConnectionRegistry,workspaceRoot:string,hostId?:string){
 const candidates=await withQueryableTransaction(db,async tx=>{
  const rows=(await tx.query<ExecutionWorkspaceRow & {responsible_user:string|null;host_owner:string|null;host_kind:string}>(`SELECT w.*,h.kind AS host_kind,h.owner_user_id AS host_owner,
   (SELECT COALESCE(r.instructed_by_user_id,r.owner_user_id) FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=w.id ORDER BY b.created_at DESC LIMIT 1) AS responsible_user
   FROM execution_workspaces w JOIN hosts h ON h.id=w.execution_host_id
   WHERE ($1::varchar IS NULL OR w.execution_host_id=$1)
    AND COALESCE((w.retention_json->>'proof_probe_at')::timestamptz,'-infinity')<=now()-interval '5 minutes'
    AND (w.retention_json->>'proof_refused_reason'='unmerged_source' OR EXISTS(SELECT 1 FROM jsonb_each(w.cleanup_json) r WHERE r.value->>'state'='retry_wait' AND r.value->>'error' LIKE 'checkpoint_not_in_%'))
   ORDER BY (w.retention_json->>'proof_probe_at')::timestamptz NULLS FIRST,w.id
   LIMIT 4 FOR UPDATE OF w SKIP LOCKED`,[hostId??null])).rows;
  for(const w of rows)await claimWorkspaceProofProbe(tx,w.id);
  return rows;
 });
 for(const w of candidates){
  const user=w.responsible_user;
  if(!user||!hosts.isOnline(w.execution_host_id)||w.host_kind==='remote'&&w.host_owner!==user||!await canWriteProject(db,w.space_id,w.project_id,user))continue;
  try{
   const observed=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{workspace:await workspaceLocationFrame(db,w,workspaceReference(w),workspaceRoot),action:'inspect',operation_id:randomUUID(),retain_branch:true});
   if(observed.ok&&observed.inventory?.target_commit)await wakeWorkspaceProofs(db,w,user,observed.commit??null,observed.inventory.target_commit);
  }catch{/* Claim remains: a failed probe must yield to the other owners. */}
 }
}
