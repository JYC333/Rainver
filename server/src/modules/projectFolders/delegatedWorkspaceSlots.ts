import {refreshWorkspaceLifecycle} from '../hosts/workspaceLifecycle.js';
import {randomUUID} from 'node:crypto';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import type {RunRecord} from '../runs/runRepositoryTypes.js';
import type {ExecutionWorkspaceRow} from './executionWorkspaces.js';

/** Only this admission wait may commit before propagating a deferred Job. */
export class WorkspaceSlotDeferred extends JobDeferredError {}

/** Called under the parent's conversation admission lock. A slot keeps its
 * original delegation provenance; bindings and batches identify each later use.
 * Only a confirmed full release permits reuse, never an idle-looking directory.
 */
export async function delegatedWorkspaceSlot(tx:Queryable,run:RunRecord,parent:ExecutionWorkspaceRow,checkpoint:string):Promise<ExecutionWorkspaceRow|null>{
 const scope=(await tx.query<{scope:string;capacity:number}>(`SELECT COALESCE(d.budget_json->>'collaboration_task_id',d.group_id) AS scope,
  CASE WHEN c.budget_json->'collaboration'->>'task_id'=d.budget_json->>'collaboration_task_id'
   THEN jsonb_array_length(c.budget_json->'collaboration'->'participant_agent_ids')
   ELSE (SELECT GREATEST(1,count(*)::int-1) FROM room_agent_members a WHERE a.space_id=g.space_id AND a.room_id=g.room_id AND a.status='active') END AS capacity
  FROM run_delegations d JOIN agent_run_groups g ON g.id=d.group_id AND g.space_id=d.space_id
  JOIN agent_run_groups c ON c.id=COALESCE(g.budget_json->>'container_group_id',g.id) AND c.space_id=g.space_id AND c.room_id IS NOT DISTINCT FROM g.room_id AND c.session_id IS NOT DISTINCT FROM g.session_id WHERE d.id=$1 AND d.space_id=$2`,[run.delegation_id,run.space_id])).rows[0];
 if(!scope)throw new HttpError(409,'workspace_placement_blocked:delegation_scope_unavailable');
 const slots=(await tx.query<ExecutionWorkspaceRow&{slot_scope:string;reusable:boolean;live:boolean}>(`SELECT w.*,COALESCE(d.budget_json->>'collaboration_task_id',d.group_id) AS slot_scope,
  w.state IN ('ready','retired') AND COALESCE((w.retention_json->>'hold_until')::timestamptz,'-infinity')<=now()
   AND (w.retention_json->>'state'='reclaimed' OR w.retention_json->>'preserved_commit'=w.head_commit) AND w.cleanup_state='cleaned'
   AND w.inventory_json->>'worktree'='false' AND w.inventory_json->>'registration'='false' AND w.inventory_json->>'branch'='false'
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(w.cleanup_json) res WHERE (res.value->>'state'<>'cleaned' AND NOT(COALESCE(res.value->>'kind','') IN ('local_preimages','run_history') AND res.value->>'state'='pending')) OR res.value ? 'inflight')
   AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.workspace_id=w.id AND b.checkpoint_state<>'saved')
   AND NOT EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=w.id AND c.state IN ('open','ready','integrating','blocked')
    AND NOT COALESCE((c.state='blocked' AND c.verification_json->>'slot_recovery'='true' AND c.verification_json->>'recovery_ref'='refs/rainver/recovery/'||c.workspace_id||'/'||c.source_commit)
     OR (c.state='open' AND c.source_commit=w.head_commit AND c.source_commit=w.retention_json->>'preserved_commit'),false))
   AND NOT EXISTS(SELECT 1 FROM workspace_source_releases f WHERE f.workspace_id=w.id)
   AS reusable,
  EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.workspace_id=w.id AND r.status NOT IN ('succeeded','failed','degraded','cancelled','orphaned'))
   OR EXISTS(SELECT 1 FROM execution_workspace_reviews v JOIN runs r ON r.id=v.run_id AND r.space_id=v.space_id WHERE v.workspace_id=w.id AND r.status NOT IN ('succeeded','failed','degraded','cancelled','orphaned')) AS live
  FROM execution_workspaces w JOIN run_delegations d ON d.id=w.delegation_id AND d.space_id=w.space_id
  WHERE w.parent_workspace_id=$1 AND w.space_id=$2 AND w.project_id=$3 AND w.execution_host_id=$4 AND w.workspace_location_id=$5
  ORDER BY w.created_at,w.id FOR UPDATE OF w`,[parent.id,run.space_id,run.project_id,parent.execution_host_id,parent.workspace_location_id])).rows;
 const idle=slots.find(s=>s.slot_scope===scope.scope&&s.reusable&&!s.live);
 if(idle){
  // Settle the exact old use while its confirmed inventory/resources still
  // belong to it. Resetting the use first would orphan its API lifecycle.
  await refreshWorkspaceLifecycle(tx,idle.id);
  if((await tx.query(`SELECT 1 FROM task_merges WHERE workspace_id=$1 AND generation=$2
   AND detail_json ? 'lifecycle' AND (detail_json->'lifecycle'->>'slot_use_id') IS NOT DISTINCT FROM $3::text
   AND detail_json->'lifecycle'->>'phase'<>'complete' LIMIT 1`,[idle.id,idle.generation,idle.retention_json?.slot_use_id??null])).rowCount)
   throw new HttpError(409,'workspace_placement_blocked:child_release_blocked');
  await clearSlotWait(tx,run.id);
  await tx.query("UPDATE workspace_change_sets SET state='blocked',revision=revision+1,verification_json=verification_json||jsonb_build_object('slot_recovery',true,'recovery_ref','refs/rainver/recovery/'||workspace_id||'/'||source_commit),updated_at=now() WHERE workspace_id=$1 AND state='open' AND source_commit=$2",[idle.id,idle.head_commit]);
  // No old physical request remains. Advance the permanent fence and preserve
  // launch sequence history; the Host rematerializes exactly the new checkpoint.
  return (await tx.query<ExecutionWorkspaceRow>(`UPDATE execution_workspaces SET state='ready',base_commit=$2,head_commit=$2,retention_json=(retention_json-ARRAY['state','reason','reclaim_after','release_epoch','release_id','preserved_commit','recovery_ref','proof_refused_reason','proof_refused_tip','proof_refused_at','proof_probe_at','proof_observed_at','proof_observation','adoption_check','missing_acknowledged_at','reclaimed_at','reclaim_requested_at','discard_intent'])||jsonb_build_object('slot_use_id',$3::text,'content_changed_at',now()),materialization_epoch=materialization_epoch+1,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[idle.id,checkpoint,randomUUID()])).rows[0]!;
 }
 if(slots.some(s=>s.slot_scope===scope.scope&&!s.live&&!s.reusable)){
  const safety=(await tx.query(`SELECT 1 FROM execution_workspaces w WHERE w.id=ANY($1::varchar[]) AND
   (w.state='blocked' OR w.cleanup_state='blocked' OR EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=w.id AND c.state='blocked' AND NOT COALESCE(c.verification_json->>'slot_recovery'='true',false)) OR EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.workspace_id=w.id AND b.checkpoint_state='blocked')) LIMIT 1`,[slots.filter(s=>s.slot_scope===scope.scope&&!s.live&&!s.reusable).map(s=>s.id)])).rowCount;
  if(safety)throw new HttpError(409,'workspace_placement_blocked:child_release_blocked');
  const waiting=slots.filter(s=>s.slot_scope===scope.scope&&!s.live&&!s.reusable);
  const identity=waiting.map(s=>`${s.id}:${s.retention_json?.slot_use_id??''}`).sort().join(',');
  const hold=Math.max(0,...waiting.map(s=>Date.parse(String(s.retention_json?.hold_until??''))||0));
  const held=hold>Date.now();
  // This write commits with the admission locks before the Job is deferred.
  // Ordinary retries/status updates preserve since. Capacity time never enters
  // this clock; a legal hold moves its start to the deadline, not to each retry.
  const clock=(await tx.query<{expired:boolean}>(`UPDATE runs SET output_json=COALESCE(output_json,'{}')||jsonb_build_object('waiting_for_workspace_release',
   jsonb_build_object('identity',$2::text,'workspace_ids',$3::jsonb,'since',GREATEST(
    CASE WHEN output_json->'waiting_for_workspace_release'->>'identity'=$2 THEN (output_json->'waiting_for_workspace_release'->>'since')::timestamptz ELSE now() END,
    COALESCE($4::timestamptz,'-infinity')),'hold_until',$4::text))
   WHERE id=$1 RETURNING (output_json->'waiting_for_workspace_release'->>'since')::timestamptz<now()-interval '30 minutes' AS expired`,
   [run.id,identity,JSON.stringify(waiting.map(s=>s.id)),held?new Date(hold).toISOString():null])).rows[0];
  if(clock?.expired)throw new HttpError(409,'workspace_placement_blocked:child_release_timeout');
  throw new WorkspaceSlotDeferred(held?'workspace_placement_blocked:child_release_hold':'workspace_placement_blocked:child_release_pending',held?Math.max(1,hold-Date.now()):30000);
 }
 await clearSlotWait(tx,run.id);
 if(slots.filter(s=>!s.reusable||s.live).length>=scope.capacity){
  // A different Task cannot inherit this slot's assets or bypass its safety
  // block. Fail visibly at the existing bound rather than queue forever.
  const blocked=slots.filter(s=>s.slot_scope!==scope.scope&&!s.reusable);
  const unsafe=blocked.length?(await tx.query<{id:string}>(`SELECT w.id FROM execution_workspaces w WHERE w.id=ANY($1::varchar[]) AND
   (w.state='blocked' OR w.cleanup_state='blocked' OR EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=w.id AND c.state='blocked' AND NOT COALESCE(c.verification_json->>'slot_recovery'='true',false)) OR EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.workspace_id=w.id AND b.checkpoint_state='blocked')) ORDER BY w.id LIMIT 1`,[blocked.map(s=>s.id)])).rows[0]:null;
  if(unsafe)throw new HttpError(409,`workspace_placement_blocked:capacity_occupied_by_blocked_workspace:${unsafe.id}`);
  throw new WorkspaceSlotDeferred('workspace_slot_capacity',30000);
 }
 return null;
}

export async function clearSlotWait(tx:Queryable,runId:string){
 await tx.query("UPDATE runs SET output_json=output_json-'waiting_for_workspace_release' WHERE id=$1 AND output_json ? 'waiting_for_workspace_release'",[runId]);
}

/** An explicit hold release wakes the existing Jobs, without creating work or
 * spending attempts. Only waits on this exact workspace are affected. */
export async function wakeSlotHoldWaiters(tx:Queryable,workspaceId:string){
 // Bound by the parent's existing (space, session) index, then exact slot/use
 // membership. No scan of unrelated Run output or another conversation.
 const scope=(await tx.query<{space_id:string;session_id:string|null;slot_use_id:string}>(`SELECT p.space_id,p.session_id,COALESCE(w.retention_json->>'slot_use_id','') AS slot_use_id FROM execution_workspaces w
  JOIN execution_workspaces p ON p.id=w.parent_workspace_id AND p.space_id=w.space_id WHERE w.id=$1`,[workspaceId])).rows[0];
 if(!scope?.session_id)return;
 await tx.query(`WITH waiting AS (UPDATE runs SET output_json=jsonb_set(output_json,'{waiting_for_workspace_release}',
  (output_json->'waiting_for_workspace_release')||jsonb_build_object('since',now(),'hold_until',NULL))
  WHERE space_id=$2 AND session_id=$3 AND status='queued'
   AND output_json->'waiting_for_workspace_release'->'workspace_ids' ? $1
   AND string_to_array(output_json->'waiting_for_workspace_release'->>'identity',',') @> ARRAY[$1||':'||$4]
   AND output_json->'waiting_for_workspace_release'->>'hold_until' IS NOT NULL RETURNING id,space_id)
  UPDATE jobs j SET scheduled_at=now(),payload_json=CASE WHEN j.status IN ('claimed','running')
   THEN j.payload_json||'{"_workspace_slot_woken":true}'::jsonb ELSE j.payload_json END
   FROM waiting r WHERE j.space_id=r.space_id AND j.payload_json->>'run_id'=r.id
   AND j.job_type='agent_run' AND j.status IN ('pending','claimed','running')`,[workspaceId,scope.space_id,scope.session_id,scope.slot_use_id]);
}
