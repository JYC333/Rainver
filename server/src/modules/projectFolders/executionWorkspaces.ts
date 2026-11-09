import {randomUUID} from 'node:crypto';
import type {ExecutionWorkspaceRef} from '@rainver/protocol';
import {HttpError,withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import type {RunRecord} from '../runs/runRepositoryTypes.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {workspaceCheckpointRunSettledSql} from './workspacePolicy.js';
import {refuseSourceFenceWithoutWaiting,retryOutsideSourceFence} from '../hosts/workspaceSourceFence.js';

export interface ExecutionWorkspaceRow {
 id:string;space_id:string;project_id:string;workspace_location_id:string;execution_host_id:string;
 baseline_mode?:'committed'|'snapshot'|null;
 owner_kind:'conversation'|'task'|'delegation';session_id:string|null;task_id:string|null;delegation_id:string|null;
 parent_workspace_id:string|null;generation:number;revision:number;state:string;base_commit:string|null;head_commit:string|null;target_ref:string|null;
}
export function isolatedWorkspaceContract(contract:unknown):boolean {
 return !!contract&&typeof contract==='object'&&(contract as {execution_workspace_version?:unknown}).execution_workspace_version===1;
}
export async function ensureExecutionWorkspace(db:Queryable,run:RunRecord,hostId:string,locationId:string,accessMode?:"read"|"write"){
 if(!run.project_id||!run.session_id)throw new HttpError(409,'Isolated execution requires a Project conversation');
 const user=run.instructed_by_user_id??run.owner_user_id;
 if(!user)throw new HttpError(403,'Execution has no responsible user');
 // The Run start holds this workspace's row lock, which the confirmation of a
 // shared-source deletion of the same workspace also takes: the fence trigger
 // must refuse at once here (never wait inside), and the whole start is retried
 // outside the transaction until that deletion ended (hosts/workspaceSourceFence).
 return retryOutsideSourceFence(()=>withQueryableTransaction(db,async tx=>{
  await refuseSourceFenceWithoutWaiting(tx);
  const source=(await tx.query<{branch:string|null;kind:string;owner_user_id:string|null;capabilities_json:{execution_workspaces?:{version:number;reclaim?:number}};workspace_baseline?:"committed"|"snapshot"|null}>(`SELECT wl.branch,h.kind,h.owner_user_id,h.capabilities_json,cx.workspace_baseline FROM workspace_locations wl JOIN project_folders f ON f.id=wl.project_folder_id JOIN hosts h ON h.id=wl.execution_host_id LEFT JOIN conversation_execution_contexts cx ON cx.session_id=$5 AND cx.space_id=wl.space_id WHERE wl.id=$1 AND wl.space_id=$2 AND f.project_id=$3 AND wl.execution_host_id=$4 AND wl.status IN ('active','stale') AND wl.execution_ready=true
    AND (wl.status='active' OR (cx.state='initialized' AND cx.primary_workspace_location_id=wl.id)
      OR EXISTS(SELECT 1 FROM conversation_folder_access_grants g WHERE g.space_id=wl.space_id AND g.session_id=$5 AND g.workspace_location_id=wl.id AND g.status='active')
      OR EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id WHERE b.run_id=$6 AND b.space_id=wl.space_id AND w.workspace_location_id=wl.id))`,[locationId,run.space_id,run.project_id,hostId,run.session_id,run.id])).rows[0];
  if(!source||source.kind==='remote'&&source.owner_user_id!==user)throw new HttpError(404,'Workspace unavailable');
  if(source.capabilities_json?.execution_workspaces?.version!==2)throw new HttpError(409,'execution_workspace_host_upgrade_required');
  await assertProjectWriterForMutation(tx,run.space_id,run.project_id!,user);
  const kind=run.delegation_id?'delegation':'conversation',owner=run.delegation_id??run.session_id!;
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`execution-workspace:${kind}:${owner}:${locationId}`]);
  const old=(await tx.query<ExecutionWorkspaceRow & {change_set_id:string;change_revision:number;launch_reference_json:ExecutionWorkspaceRef|null;change_state:string;retained_workspace_id:string|null}>(`SELECT w.*,b.change_set_id,b.launch_reference_json,c.revision AS change_revision,c.state AS change_state,c.verification_json->>'continuation_from_workspace_id' AS retained_workspace_id FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id JOIN workspace_change_sets c ON c.id=b.change_set_id WHERE b.run_id=$1 AND b.space_id=$2 AND w.workspace_location_id=$3`,[run.id,run.space_id,locationId])).rows[0];
  if(old?.state==='blocked')throw new HttpError(409,'workspace_permission_violation_needs_review');
  if(old?.state==='retired')throw new HttpError(409,'execution_workspace_generation_retired');
  if(old&&['integrated','no_changes','abandoned'].includes(old.change_state))throw new HttpError(409,'workspace_change_already_closed');
  if(old)return {workspace:old,changeSetId:old.change_set_id,changeRevision:old.change_revision,ref:old.launch_reference_json??workspaceReference(old),...(old.retained_workspace_id?{retainedWorkspaceId:old.retained_workspace_id}:{})};
  let workspace=(await tx.query<ExecutionWorkspaceRow>(`SELECT * FROM execution_workspaces WHERE space_id=$1 AND workspace_location_id=$2 AND owner_kind=$3 AND ${kind==='delegation'?'delegation_id':'session_id'}=$4 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,[run.space_id,locationId,kind,owner])).rows[0];
  // A new turn may leave an unusable generation behind. Never revive, abandon,
  // publish or clean that generation, and never import its unverified result.
  const stranded=workspace&&workspace.state!=='retired'&&(workspace.state==='blocked'||Boolean((await tx.query(`SELECT 1 FROM execution_workspace_runs b
   JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id JOIN workspace_change_sets c ON c.id=b.change_set_id
   WHERE b.workspace_id=$1 AND ${workspaceCheckpointRunSettledSql('r')} AND
    (b.checkpoint_state='blocked' OR c.verification_json->'checkpoint_recovery'->>'state'='exhausted'
     OR (b.start_commit IS NULL AND r.status IN ('failed','degraded','cancelled','orphaned')
      AND NOT EXISTS (SELECT 1 FROM execution_workspace_runs launched
       WHERE launched.workspace_id=b.workspace_id AND launched.start_commit IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM execution_workspace_runs active_binding
       JOIN runs active_run ON active_run.id=active_binding.run_id AND active_run.space_id=active_binding.space_id
       WHERE active_binding.workspace_id=b.workspace_id AND NOT ${workspaceCheckpointRunSettledSql('active_run')}))) LIMIT 1`,[workspace.id])).rowCount));
  const retainedWorkspaceId=stranded?workspace.id:null;
  if(!workspace||workspace.state==='retired'||stranded){
   const generation=(workspace?.generation??0)+1;
   const parent=run.parent_run_id?(await tx.query<{workspace_id:string;checkpoint_commit:string|null;checkpoint_state:string}>(`SELECT b.workspace_id,b.checkpoint_commit,b.checkpoint_state FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id WHERE b.run_id=$1 AND b.space_id=$2 AND w.workspace_location_id=$3 AND w.project_id=$4 AND w.execution_host_id=$5 ORDER BY b.created_at LIMIT 1`,[run.parent_run_id,run.space_id,locationId,run.project_id,hostId])).rows[0]:null;
   if(run.delegation_id && (!parent?.checkpoint_commit || parent.checkpoint_state!=='saved'))throw new HttpError(409,'workspace_parent_checkpoint_required');
   workspace=(await tx.query<ExecutionWorkspaceRow>(`INSERT INTO execution_workspaces(id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,session_id,delegation_id,parent_workspace_id,target_ref,base_commit,generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[randomUUID(),run.space_id,run.project_id,locationId,hostId,kind,kind==='conversation'?run.session_id:null,run.delegation_id??null,parent?.workspace_id??null,parent?`refs/heads/rainver/workspace-${parent.workspace_id}-g${(await tx.query<{generation:number}>('SELECT generation FROM execution_workspaces WHERE id=$1',[parent.workspace_id])).rows[0]!.generation}`:source.branch?`refs/heads/${source.branch}`:null,parent?.checkpoint_commit??null,generation])).rows[0]!;
  }
  if(workspace.state==='blocked')throw new HttpError(409,'workspace_permission_violation_needs_review');
  const outstanding=Boolean((await tx.query("SELECT 1 FROM workspace_change_sets WHERE workspace_id=$1 AND state IN ('open','ready','integrating','blocked') LIMIT 1",[workspace.id])).rowCount);
  let rebuilding=false;
  const ref:ExecutionWorkspaceRef={...workspaceReference(workspace),...(source.workspace_baseline?{baseline_mode:source.workspace_baseline}:{}),...(!outstanding&&!workspace.parent_workspace_id&&workspace.head_commit?{sync_to_target:true}:{})};
  if((source.capabilities_json?.execution_workspaces?.reclaim??0)>=1){
   // Same identity after a cold reclaim: the native session and cwd survive.
   // The epoch fences older cleanup; the floor keeps launch sequences monotonic.
   // Released and not yet rebuilt: no batch of this workspace was launched or
   // saved since (a release requires every earlier batch closed, so an open
   // one was created after it, e.g. by a Run that failed before its launch).
   const identity=(await tx.query<{epoch:number;floor:number;released:boolean}>(`SELECT w.materialization_epoch AS epoch,GREATEST(w.head_sequence,COALESCE((SELECT MAX(b.launch_sequence) FROM execution_workspace_runs b WHERE b.workspace_id=w.id),0)) AS floor,
     COALESCE(w.retention_json->>'state','') IN ('reclaimed','reclaiming') AND NOT EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=w.id AND c.state IN ('open','ready','integrating','blocked')
      AND (c.source_commit IS NOT NULL OR EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id AND b.start_commit IS NOT NULL))) AS released FROM execution_workspaces w WHERE w.id=$1`,[workspace.id])).rows[0]!;
   ref.materialization_epoch=identity.epoch;ref.launch_sequence_floor=Math.min(identity.floor,2147483646);
   // Its proven content is target history; rebuild from the target, not from a
   // released tip that Git maintenance may already have pruned. While a release
   // is in flight (its reply not back yet) the branch may already be gone, so
   // `reclaiming` is treated the same: the Host serializes this launch against
   // that release under the Task lease and either rebuilds from the target or,
   // if the release had not run, syncs the still-present branch to the target
   // (the idle-sync path that keeps the old tip as a recovery ref) and fences
   // the older release by this launch's newer epoch.
   // An open batch nobody launched (the previous Run failed first) does not
   // make the released tip a valid base: it is rebuilt from the target too.
   if(identity.released&&!workspace.parent_workspace_id){delete ref.base_commit;ref.sync_to_target=true;rebuilding=true;}
  }
  let change=(await tx.query<{id:string;revision:number;retained_workspace_id:string|null}>(`SELECT id,revision,verification_json->>'continuation_from_workspace_id' AS retained_workspace_id FROM workspace_change_sets WHERE workspace_id=$1 AND state='open' FOR UPDATE`,[workspace.id])).rows[0];
  if(!change)change=(await tx.query<{id:string;revision:number;retained_workspace_id:string|null}>(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,base_commit,verification_json) SELECT $1::varchar,$2::varchar,$3::varchar,$4::integer,COALESCE(max(sequence),0)+1,$5::varchar,$6::varchar,$7::varchar,$8::jsonb FROM workspace_change_sets WHERE workspace_id=$2 RETURNING id,revision,verification_json->>'continuation_from_workspace_id' AS retained_workspace_id`,[randomUUID(),workspace.id,run.space_id,workspace.generation,run.id,run.root_run_id??run.id,
   // A rebuild never registers the released tip as a base (it is no dependent
   // and may already be pruned); the launch records the rebuilt start.
   rebuilding?null:workspace.head_commit??workspace.base_commit,JSON.stringify({adopted_child_change_ids:[],...(retainedWorkspaceId?{continuation_from_workspace_id:retainedWorkspaceId}:{})})])).rows[0];
  await tx.query('INSERT INTO execution_workspace_runs(run_id,workspace_id,space_id,change_set_id,launch_reference_json,access_mode) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[run.id,workspace.id,run.space_id,change!.id,JSON.stringify(ref),accessMode??((run.contract_snapshot_json as {workspace_access?:string})?.workspace_access==='read'?'read':'write')]);
  await new PgJobQueueRepository(tx).enqueue({job_type:'execution_workspace_checkpoint',space_id:run.space_id,user_id:user,payload:{run_id:run.id,workspace_id:workspace.id}});
  return {workspace,changeSetId:change!.id,changeRevision:change!.revision,ref,...(change!.retained_workspace_id?{retainedWorkspaceId:change!.retained_workspace_id}:{})};
 }));
}
export function workspaceReference(w:ExecutionWorkspaceRow):ExecutionWorkspaceRef {
 return {id:w.id,generation:w.generation,...(w.head_commit??w.base_commit?{base_commit:(w.head_commit??w.base_commit)!}:{}),...(w.target_ref?{target_ref:w.target_ref}:{})};
}
export async function recordWorkspaceLaunch(db:Queryable,run:RunRecord,info:{id:string;generation:number;start_commit:string;target_ref:string|null;baseline_kind?:"committed"|"snapshot";snapshot_head?:string|null;baseline_tree?:string|null;launch_sequence?:number}){
 await withQueryableTransaction(db,async tx=>{
  const w=(await tx.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2 AND generation=$3 FOR UPDATE',[info.id,run.space_id,info.generation])).rows[0];
  if(!w)throw new HttpError(409,'execution_workspace_generation_mismatch');
  if(w.state==='blocked')throw new HttpError(409,'workspace_permission_violation_needs_review');
  if(w.state==='retired')throw new HttpError(409,'execution_workspace_generation_retired');
  const updated=await tx.query(`UPDATE execution_workspace_runs SET start_commit=$4,checkpoint_state='pending',launch_sequence=$5 WHERE run_id=$1 AND space_id=$2 AND workspace_id=$3`,[run.id,run.space_id,w.id,info.start_commit,info.launch_sequence??1]);
  if(!updated.rowCount)throw new HttpError(409,'execution_workspace_run_mismatch');
  // A rebuilt materialization is active again; its earlier reclaim stays as
  // history. Its start is the new base and tip: a released tip must not stay
  // recorded as head/base, or a later cleanup would expect (and a rebuild
  // would start from) a commit the Host no longer has. A late reply of the
  // older release sees `active` and leaves this state alone.
  const rebuilt=(await tx.query<{released:boolean}>(`SELECT COALESCE(retention_json->>'state','') IN ('reclaimed','reclaiming') AS released FROM execution_workspaces WHERE id=$1`,[w.id])).rows[0]?.released;
  if(rebuilt){
   await tx.query('UPDATE execution_workspaces SET base_commit=$2,head_commit=$2 WHERE id=$1',[w.id,info.start_commit]);
   // Every unlaunched batch opened since the release (however many Runs joined
   // it before one launched) now starts at the rebuilt base, not the released tip.
   await tx.query("UPDATE workspace_change_sets SET base_commit=$2 WHERE workspace_id=$1 AND state='open' AND source_commit IS NULL",[w.id,info.start_commit]);
  }
  await tx.query(`UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('state','active','reason','run_active','assessed_at',now()) WHERE id=$1 AND retention_json->>'state' IS DISTINCT FROM 'active'`,[w.id]);
  await tx.query(`UPDATE execution_workspaces SET state='ready',base_commit=COALESCE(base_commit,$3),target_ref=COALESCE(target_ref,$4),baseline_mode=COALESCE($5,baseline_mode),snapshot_head=COALESCE($6,snapshot_head),base_tree=COALESCE($7,base_tree),updated_at=now() WHERE id=$1 AND space_id=$2`,[w.id,run.space_id,info.start_commit,info.target_ref,info.baseline_kind??null,info.snapshot_head??null,info.baseline_tree??null]);
  await tx.query(`UPDATE workspace_change_sets SET base_commit=CASE WHEN source_commit IS NULL AND (SELECT count(*) FROM execution_workspace_runs WHERE change_set_id=workspace_change_sets.id)=1 THEN $3 ELSE COALESCE(base_commit,$3) END WHERE id=(SELECT change_set_id FROM execution_workspace_runs WHERE run_id=$1 AND workspace_id=$2)`,[run.id,w.id,info.start_commit]);
  const jobs=new PgJobQueueRepository(tx);
  const queued=(await tx.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_checkpoint' AND status IN ('pending','claimed','running') AND payload_json->>'run_id'=$1 AND payload_json->>'workspace_id'=$2 LIMIT 1",[run.id,w.id])).rowCount;
  if(!queued)await jobs.enqueue({job_type:'execution_workspace_checkpoint',space_id:run.space_id,user_id:run.instructed_by_user_id??run.owner_user_id??null,payload:{run_id:run.id,workspace_id:w.id}});
 });
}

/** Resolution Runs bind only to the current server-created integration attempt. */
export async function integrationWorkspaceForRun(db:Queryable,run:RunRecord,hostId:string,locationId:string,inline?:{id:string;attempt:string}){
 const contract=run.contract_snapshot_json as {workspace_integration_id?:string;workspace_integration_attempt_id?:string};
 const row=(await db.query<{workspace_id:string;generation:number;attempt_id:string;change_set_id:string;change_revision:number}>(`SELECT m.workspace_id,m.generation,m.attempt_id,m.change_set_id,c.revision AS change_revision FROM task_merges m JOIN workspace_change_sets c ON c.id=m.change_set_id
   WHERE m.id=$1 AND m.space_id=$2 AND (m.resolution_run_id=$3 OR (m.detail_json->>'reply_owner_run_id'=$3 AND m.detail_json->>'inline_phase_state'='running')) AND m.status='resolving' AND m.attempt_id=$4`,[inline?.id??contract.workspace_integration_id,run.space_id,run.id,inline?.attempt??contract.workspace_integration_attempt_id])).rows[0];
 if(!row)throw new HttpError(409,'workspace_integration_attempt_changed');
 const workspace=(await db.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2 AND execution_host_id=$3 AND workspace_location_id=$4 AND project_id=$5',[row.workspace_id,run.space_id,hostId,locationId,run.project_id])).rows[0];
 if(!workspace)throw new HttpError(404,'Workspace unavailable');
 const host=(await db.query<{capabilities_json:{execution_workspaces?:{version:number}}}>('SELECT capabilities_json FROM hosts WHERE id=$1',[hostId])).rows[0];
 if(host?.capabilities_json?.execution_workspaces?.version!==2)throw new HttpError(409,'execution_workspace_host_upgrade_required');
 const user=run.instructed_by_user_id??run.owner_user_id;
 if(!user)throw new HttpError(403,'Execution has no responsible user');
 await assertProjectWriterForMutation(db,run.space_id,workspace.project_id,user);
 return {workspace,changeSetId:row.change_set_id,changeRevision:row.change_revision,ref:{id:workspace.id,generation:row.generation,integration_id:row.attempt_id} as ExecutionWorkspaceRef};
}


export async function completedWorkspaceRun(db:Queryable,changeId:string,spaceId:string){
 const binding=(await db.query<{run_id:string}>(`SELECT b.run_id FROM execution_workspace_runs b JOIN workspace_change_sets c ON c.id=b.change_set_id
  WHERE c.id=$1 AND c.space_id=$2 AND (c.completion_basis LIKE 'user:%' OR b.run_id=c.completion_basis)
  ORDER BY b.created_at DESC,b.run_id DESC LIMIT 1`,[changeId,spaceId])).rows[0];
 return binding?new (await import('../runs/repository.js')).PgRunRepository(db).getRun(spaceId,binding.run_id):null;
}
