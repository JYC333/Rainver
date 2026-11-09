/** Typed bounds for automatic work; explicit retries remain revision checked. */
export const WORKSPACE_INTEGRATION_LIMITS=Object.freeze({
 automaticRepairs:1,targetMoves:5,repairMaxSeconds:300,repairMaxCost:2,
});

/** Only transport/lease failures may wait without consuming a Job attempt. */
export const WORKSPACE_TEMPORARY_HOST_ERRORS=Object.freeze(['host_offline','host_disconnected','task_busy','location_busy','host_timeout']);
export function workspaceHostFailureIsTemporary(error:string|null|undefined){
 return WORKSPACE_TEMPORARY_HOST_ERRORS.includes(error??'');
}

/** A durable dependency park is not physical process exit: the lease must be gone.
 * Alias is code-owned. Reuse the canonical wait/attempt and execution-lock records. */
export function workspaceCheckpointRunSettledSql(alias:string){
 return `(${alias}.status IN ('succeeded','failed','degraded','cancelled','orphaned') OR
  (${alias}.status='waiting_for_dependency' AND ${alias}.run_group_id IS NOT NULL
   AND ${alias}.output_json->'waiting_for_results'->>'status'='waiting'
   AND EXISTS(SELECT 1 FROM run_attempts checkpoint_attempt WHERE checkpoint_attempt.run_id=${alias}.id
    AND checkpoint_attempt.space_id=${alias}.space_id AND checkpoint_attempt.status='waiting_for_dependency'
    AND checkpoint_attempt.attempt_number=(SELECT max(latest.attempt_number) FROM run_attempts latest WHERE latest.run_id=${alias}.id AND latest.space_id=${alias}.space_id))
   AND NOT EXISTS(SELECT 1 FROM run_execution_locks checkpoint_lock WHERE checkpoint_lock.run_id=${alias}.id)))`;
}


/** Unknown Host/IO errors are operational, never evidence of a permission breach. */
export function workspaceCheckpointFailureIsSafetyViolation(error:unknown){
 const reason=error instanceof Error?error.message:String(error);
 return ['read_only_workspace_modified',
  'workspace_checkpoint_actor_missing','execution_workspace_host_authority_changed',
  'execution_workspace_generation_mismatch','execution_workspace_run_mismatch',
  'workspace_permission_violation_needs_review','workspace_generation_moved',
  'workspace_mirror_checkpoint_moved','execution_workspace_invalid'].includes(reason)||
  (error instanceof Error&&'statusCode' in error&&error.statusCode===403);
}
