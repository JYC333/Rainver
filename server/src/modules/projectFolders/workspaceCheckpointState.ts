/** Checkpoint recovery belongs to one binding's current launch. Change-set
 * metadata is a display aggregate, never admission or retry authority. */
export interface CheckpointRecovery {
 state?: 'requested'|'waiting'|'retrying'|'exhausted'|'settled';
 request_id?: string;
 error?: string;
 launch_sequence?: number;
 outcome?: 'not_started'|'unchanged';
}

/** Code-owned aliases only. A reused logical Run starts fresh on a new launch. */
export function checkpointExhaustedSql(alias:string){
 return `(${alias}.checkpoint_state='pending' AND COALESCE(${alias}.checkpoint_recovery_json->>'state'='exhausted',false))`;
}

/** Eligibility for deferred proof, never proof of a saved tree or deletion. */
export function unlaunchedCheckpointSql(binding:string,run:string){
 return `(${binding}.checkpoint_state='pending' AND ${binding}.start_commit IS NULL AND ${binding}.launch_sequence=0
  AND ${run}.status IN ('failed','cancelled','orphaned','degraded')
  AND NOT EXISTS(SELECT 1 FROM run_execution_locks unlaunched_lock WHERE unlaunched_lock.run_id=${run}.id))`;
}

/** Preserve the existing read contract without storing a second authority. */
export function checkpointRecoverySummarySql(changeAlias:string){
 return `(SELECT recovery.checkpoint_recovery_json||jsonb_build_object('run_id',recovery.run_id)
  FROM execution_workspace_runs recovery WHERE recovery.change_set_id=${changeAlias}.id AND recovery.space_id=${changeAlias}.space_id
   AND recovery.checkpoint_state='pending' AND recovery.checkpoint_recovery_json<>'{}'::jsonb
  ORDER BY (recovery.checkpoint_recovery_json->>'state'='exhausted') DESC,recovery.launch_sequence DESC,recovery.run_id LIMIT 1)`;
}

export function allPendingCheckpointsExhaustedSql(changeAlias:string){
 return `(EXISTS(SELECT 1 FROM execution_workspace_runs pending WHERE pending.change_set_id=${changeAlias}.id AND ${checkpointExhaustedSql('pending')})
  AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs pending WHERE pending.change_set_id=${changeAlias}.id
   AND pending.checkpoint_state='pending' AND NOT COALESCE(${checkpointExhaustedSql('pending')},false)))`;
}

export function checkpointRecoveryProjectionSql(changeAlias:string){
 return `(SELECT jsonb_strip_nulls(jsonb_build_object('checkpoint_recovery',summary,
  'error',CASE WHEN summary->>'state'='exhausted' THEN summary->>'error' ELSE NULL END))
  FROM (SELECT ${checkpointRecoverySummarySql(changeAlias)} AS summary) checkpoint_projection)`;
}

export function checkpointRecoveryPayload(runId:string,workspaceId:string,sequence:number,recovery:CheckpointRecovery={}){
 return {run_id:runId,workspace_id:workspaceId,launch_sequence:sequence,checkpoint_recovery_id:recovery.request_id??''};
}
