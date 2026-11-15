/** Complete source absence, rather than a missing branch alone. */
function sourceAbsentSql(observation:string){
 return `(${observation}->>'branch'='false' AND ${observation}->>'worktree'='false'
  AND ${observation}->>'registration'='false' AND ${observation}->>'run_record'='false'
  AND ${observation}->>'merge_record'='false' AND ${observation}->>'active'='false'
  AND COALESCE((${observation}->>'quarantined_whole')::int,0)=0)`;
}

/** Acknowledging a missing source closes its dependency, not its merge history.
 * All callers still check open batches and live Runs independently. */
export function acknowledgedMissingSourceSql(w:string){
 return `(${w}.retention_json->>'state'='missing' AND ${w}.retention_json->>'reason'='missing_acknowledged'
  AND ${w}.retention_json->>'missing_acknowledged_at' IS NOT NULL AND ${w}.cleanup_state='cleaned'
  AND ${sourceAbsentSql(`${w}.inventory_json`)})`;
}

export function childSourceHeldSql(w:string){
 return `(${w}.head_commit IS NOT NULL AND COALESCE(${w}.retention_json->>'state','')<>'reclaimed'
  AND NOT COALESCE(${acknowledgedMissingSourceSql(w)},false))`;
}

/** Host-observed absence can retire cleanup attention for already abandoned,
 * unsaved history. It never changes a binding into a saved checkpoint and is
 * invalid as soon as a new owner, epoch, batch or physical resource appears. */
export function closedCheckpointHistorySql(w:string,observation=`${w}.inventory_json`){
 return `(${w}.state='retired' AND ${w}.head_commit IS NULL
  AND ${observation}->>'checkpoint_history_generation'=${w}.generation::text
  AND ${observation}->>'checkpoint_history_epoch'=${w}.materialization_epoch::text
  AND ${observation}->>'checkpoint_history_closed_at' IS NOT NULL
  AND ${sourceAbsentSql(observation)}
  AND NOT EXISTS(SELECT 1 FROM workspace_change_sets history WHERE history.workspace_id=${w}.id
   AND (history.state<>'abandoned' OR history.source_commit IS NOT NULL OR history.verification_json->'native_progress'->>'status'='pending'))
  AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs history_binding JOIN runs history_run ON history_run.id=history_binding.run_id
   WHERE history_binding.workspace_id=${w}.id AND history_run.status NOT IN ('succeeded','failed','degraded','cancelled','orphaned'))
  AND NOT EXISTS(SELECT 1 FROM execution_workspace_reviews history_review JOIN runs history_run ON history_run.id=history_review.run_id
   WHERE history_review.workspace_id=${w}.id AND history_run.status NOT IN ('succeeded','failed','degraded','cancelled','orphaned'))
  AND NOT EXISTS(SELECT 1 FROM task_merges history_merge WHERE history_merge.workspace_id=${w}.id
   AND history_merge.status IN ('queued','rebasing','resolving','verifying','waiting_local_changes'))
  AND NOT EXISTS(SELECT 1 FROM jobs history_job WHERE history_job.status IN ('pending','claimed','running')
   AND history_job.job_type IN ('execution_workspace_checkpoint','execution_workspace_complete','execution_workspace_native_integrate','execution_workspace_cleanup','task_merge')
   AND (history_job.payload_json->>'workspace_id'=${w}.id
    OR EXISTS(SELECT 1 FROM workspace_change_sets history_change WHERE history_change.workspace_id=${w}.id AND history_change.id=history_job.payload_json->>'change_set_id')))
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(${w}.cleanup_json) history_resource WHERE history_resource.value->>'state'<>'cleaned'))`;
}
