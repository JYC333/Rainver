import {unlaunchedCheckpointSql} from './workspaceCheckpointState.js';
import {workspaceCheckpointRunSettledSql} from './workspacePolicy.js';
import {randomUUID} from 'node:crypto';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from '../hosts/connectionRegistry.js';
import {workspaceLocationFrame} from '../hosts/workspaceLocation.js';
import {confirmCheckpointExit} from './workspaceCheckpointRecovery.js';
import {PgRunRepository} from '../runs/repository.js';
import {workspaceReference,type ExecutionWorkspaceRow} from './executionWorkspaces.js';
import {assertProjectWriterForMutation} from '../projects/access.js';

/** Recover only a terminal binding with no recorded launch, against a saved
 * generation. Missing receipts alone are not evidence: the Host must prove a
 * clean unchanged tree under its lease, after the exact old process exits. */
export async function recoverUnlaunchedWorkspaceCheckpoint(db:Queryable,runId:string,workspaceId:string,spaceId:string,
 hosts:HostConnectionRegistry=sharedHostConnectionRegistry,workspaceRoot?:string){
 // Observe and perform Host I/O without a database lock. Commit only if this
 // exact owner, binding, attempt and saved version still match afterwards.
 type Snapshot=ExecutionWorkspaceRow&{materialization_epoch:number;head_sequence:number};
 const w=(await db.query<Snapshot>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2',[workspaceId,spaceId])).rows[0];
 if(!w||w.state==='blocked')return false;
 const binding=(await db.query<{change_set_id:string;user_id:string;change_revision:number;change_generation:number;request_id:string;source_commit:string|null;base_commit:string|null}>(`SELECT b.change_set_id,c.source_commit,c.base_commit,c.generation AS change_generation,c.revision AS change_revision,COALESCE(b.checkpoint_recovery_json->>'request_id','') AS request_id,COALESCE(r.instructed_by_user_id,r.owner_user_id) AS user_id
   FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
   JOIN workspace_change_sets c ON c.id=b.change_set_id AND c.space_id=b.space_id
   WHERE b.run_id=$1 AND b.workspace_id=$2 AND b.space_id=$3 AND (c.source_commit IS NOT DISTINCT FROM $4::varchar OR c.source_commit IS NULL) AND ${unlaunchedCheckpointSql('b','r')}`,[runId,workspaceId,spaceId,w.head_commit])).rows[0];
  if(!binding?.user_id||binding.change_generation!==w.generation)return false;
  // An unlaunched batch can own only its baseline, never a later batch's head.
  if(binding.source_commit===null&&binding.base_commit!==null&&binding.base_commit!==w.head_commit)return false;
  await assertProjectWriterForMutation(db,spaceId,w.project_id,binding.user_id);
  const expected=binding.source_commit??binding.base_commit;
  const workspace=await workspaceLocationFrame(db,w,workspaceReference(w),workspaceRoot,binding.user_id);
  const previous=await new PgRunRepository(db).getLatestRunAttempt(spaceId,runId);
  const exit=await confirmCheckpointExit(db,spaceId,runId,w.execution_host_id,hosts);
  if(!exit.confirmed)return false;
  const inspected=await hosts.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{
   workspace,
   action:'inspect',run_id:runId,operation_id:randomUUID(),...(expected?{expected_commit:expected}:{}),retain_branch:true});
  if(!inspected.ok||inspected.launch_info)return false;
  const absent=!exit.dispatched&&!expected&&inspected.inventory?.branch===false&&inspected.inventory.worktree===false
   &&inspected.inventory.registration===false&&inspected.inventory.run_record===false
   &&inspected.inventory.merge_record===false&&inspected.inventory.quarantined_whole===0&&inspected.inventory.retained_quarantine===0&&inspected.inventory.active===false;
  if(expected?inspected.unchanged_commit!==expected:!absent)return false;
 return withQueryableTransaction(db,async tx=>{
  const current=(await tx.query<Snapshot>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2 FOR UPDATE',[workspaceId,spaceId])).rows[0];
  if(!current||current.revision!==w.revision||current.generation!==w.generation||current.state!==w.state
   ||current.materialization_epoch!==w.materialization_epoch||current.head_sequence!==w.head_sequence||current.head_commit!==w.head_commit
   ||current.project_id!==w.project_id||current.execution_host_id!==w.execution_host_id||current.workspace_location_id!==w.workspace_location_id)return false;
  await assertProjectWriterForMutation(tx,spaceId,w.project_id,binding.user_id);
  await workspaceLocationFrame(tx,current,workspaceReference(current),workspaceRoot,binding.user_id);
  if((await tx.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
    WHERE b.workspace_id=$1 AND NOT ${workspaceCheckpointRunSettledSql('r')} LIMIT 1`,[workspaceId])).rowCount)return false;
  const change=(await tx.query<{revision:number;generation:number;base_commit:string|null;source_commit:string|null}>('SELECT revision,generation,base_commit,source_commit FROM workspace_change_sets WHERE id=$1 FOR UPDATE',[binding.change_set_id])).rows[0];
  if(!change||change.revision!==binding.change_revision||change.source_commit!==binding.source_commit
   ||change.generation!==binding.change_generation||change.generation!==current.generation||change.base_commit!==binding.base_commit)return false;
  const saved=await tx.query(`UPDATE execution_workspace_runs b SET checkpoint_state='saved',checkpoint_commit=$4,checkpoint_recovery_json=$9::jsonb
   WHERE b.run_id=$1 AND b.workspace_id=$2 AND b.space_id=$3 AND b.change_set_id=$11 AND EXISTS(SELECT 1 FROM runs r WHERE r.id=b.run_id AND r.space_id=b.space_id AND ${unlaunchedCheckpointSql('b','r')})
    AND COALESCE(b.checkpoint_recovery_json->>'request_id','')=$7
    AND EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.id=b.change_set_id AND c.revision=$8 AND c.source_commit IS NOT DISTINCT FROM $10::varchar AND c.generation=$12 AND c.base_commit IS NOT DISTINCT FROM $13::varchar)
    AND (SELECT a.id FROM run_attempts a WHERE a.run_id=b.run_id AND a.space_id=b.space_id ORDER BY a.attempt_number DESC LIMIT 1) IS NOT DISTINCT FROM $5::varchar
    AND (SELECT a.launch_id FROM run_attempts a WHERE a.run_id=b.run_id AND a.space_id=b.space_id ORDER BY a.attempt_number DESC LIMIT 1) IS NOT DISTINCT FROM $6::varchar`,
   [runId,workspaceId,spaceId,expected,previous?.id??null,previous?.launch_id??null,binding.request_id,binding.change_revision,JSON.stringify({state:'settled',outcome:absent?'not_started':'unchanged'}),binding.source_commit,binding.change_set_id,binding.change_generation,binding.base_commit]);
  if(!saved.rowCount)return false;
  if(!binding.source_commit&&expected)await tx.query('UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1',[binding.change_set_id,expected]);
  await tx.query(`UPDATE workspace_change_sets SET verification_json=verification_json||jsonb_build_object('unlaunched_checkpoint_recovery',
   COALESCE(verification_json->'unlaunched_checkpoint_recovery','{}'::jsonb)||jsonb_build_object($2::text,$3::text)),
   revision=revision+CASE WHEN $4::boolean THEN 1 ELSE 0 END,updated_at=now()
   WHERE id=$1`,[binding.change_set_id,runId,expected,!binding.source_commit&&Boolean(expected)]);
  if(absent)await tx.query(`UPDATE workspace_change_sets c SET state='no_changes',revision=revision+1,updated_at=now()
   WHERE c.id=$1 AND c.state='open' AND c.base_commit IS NULL AND c.source_commit IS NULL
    AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id AND b.checkpoint_state<>'saved')`,[binding.change_set_id]);
  return true;
 });
}
