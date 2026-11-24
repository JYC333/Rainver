import {closedCheckpointHistorySql} from './workspaceReleaseState.js';
import {unlaunchedCheckpointSql} from './workspaceCheckpointState.js';
import {WORKSPACE_TEMPORARY_HOST_ERRORS} from './workspacePolicy.js';
import type {Queryable} from '../routeUtils/common.js';

/** Path-free projection of canonical obligations, never a second state machine. */
export async function workspaceRecoveryDiagnostics(db:Queryable,workspaceId:string,changeSetId:string){
 const rows=(await db.query<{kind:'cleanup'|'checkpoint';state:string;reason:string|null;next_retry_at:string|null;attempts:number;recoverable:boolean;selected:boolean;historical:boolean}>(`
  SELECT 'cleanup'::text AS kind,r.value->>'state' AS state,r.value->>'error' AS reason,
   r.value->>'next_retry_at' AS next_retry_at,COALESCE((r.value->>'attempts')::int,0) AS attempts,
   r.value->'workspace'->>'generation'=w.generation::text AS recoverable,true AS selected,false AS historical
   FROM execution_workspaces w CROSS JOIN LATERAL jsonb_each(w.cleanup_json) r
   WHERE w.id=$1 AND r.value->>'state'<>'cleaned'
  UNION ALL
  SELECT 'cleanup','blocked','workspace_quarantined',NULL,0,false,true,false
   FROM execution_workspaces w WHERE w.id=$1 AND COALESCE((w.inventory_json->>'quarantined_whole')::int,0)>0
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(w.cleanup_json) r WHERE r.value->>'state'='blocked')
  UNION ALL
  SELECT 'checkpoint',COALESCE(NULLIF(b.checkpoint_recovery_json->>'state',''),b.checkpoint_state),
   COALESCE(b.checkpoint_recovery_json->>'error',CASE WHEN c.source_commit IS NULL THEN 'workspace_source_unconfirmed' END),
   NULL,0, b.change_set_id=$2 AND c.generation=w.generation AND b.checkpoint_state<>'blocked' AND ${unlaunchedCheckpointSql('b','r')},b.change_set_id=$2,COALESCE(${closedCheckpointHistorySql('w')},false)
   FROM execution_workspace_runs b JOIN workspace_change_sets c ON c.id=b.change_set_id
   JOIN execution_workspaces w ON w.id=b.workspace_id JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
   WHERE b.workspace_id=$1 AND b.checkpoint_state<>'saved'
  ORDER BY kind,state,reason`,[workspaceId,changeSetId])).rows;
 const blocker=await workspaceRecoveryBlocker(db,workspaceId);
 const retryBlocker=await workspaceRecoveryBlocker(db,workspaceId,'retry');
 return rows.map(({recoverable:eligible,selected,historical,...r})=>{
  const mode=r.kind==='cleanup'&&r.state==='blocked'?'retry' as const:'recover' as const;
  const recoverable=!historical&&eligible&&!(mode==='retry'?retryBlocker:blocker);
  const raw=r.reason?.replace(/^Error: /,'');
  const reason=raw&&/^[a-z][a-z_]+$/.test(raw)?raw:r.reason?'workspace_recovery_failed':null;
  const guidance=r.state==='blocked'
   ?'Inspect the reported refusal, resolve its cause, then call workspace.retention.update with action: retry and the current expected_revision. The existing Job rechecks Host safety and replays the same issued cleanup request; retry is not proof of completion.'
   :reason?.includes('active')||reason?.includes('dependencies')||reason?.includes('owed')
   ?'Wait for the named Run, checkpoint or dependency to settle. Recovery rechecks these guards and cannot override them.'
   :reason?.includes('host')||reason?.includes('transport')
   ?'Restore the owning Host and its required capability. Recover the existing obligation; an offline Host proves nothing about retained content.'
   :r.kind==='checkpoint'
   ?'Recover the terminal checkpoint. Only Host-confirmed exit and unchanged-tree or complete-absence evidence can settle it; unknown files remain preserved.'
   :'Recover the existing cleanup request with its original journal identity. Read the result after its receipt; do not replace it with a new discard.';
  return {...r,reason,recovery_mode:recoverable?mode:null,recovery_action:recoverable?'workspace.retention.update' as const:null,guidance:r.reason==='workspace_quarantined'&&!eligible?'A preserved workspace directory has no failed cleanup task to retry. Host maintenance classifies dependency-only remnants; unknown contents require owner inspection before removal.':historical?'Historical checkpoint failure: this abandoned source was confirmed absent by its Host. The failure remains in the audit history; no cleanup or checkpoint retry is required.':!selected?'Preserve the files. This checkpoint requires recovery authorized for its own batch; recovery of the selected batch does not process it.':recoverable?guidance
   :r.kind==='cleanup'?'Preserve the evidence. Inspect this exact resource after the active Run or checkpoint settles; an old generation cannot be retried as the current one.'
   :'Preserve the files. A blocked or launched checkpoint requires its canonical checkpoint recovery and current owner; generic unlaunched recovery is not evidence of an empty Run.'};
 });
}

/** Shared advisory and locked admission; recovery never overrides live/safety debt. */
export async function workspaceRecoveryBlocker(db:Queryable,workspaceId:string,mode:'recover'|'retry'='recover'){
 const r=(await db.query<{blocked:boolean;cleanup_blocked:boolean;unsupported:boolean;active:boolean;retryable:boolean}>(`SELECT
  EXISTS(SELECT 1 FROM jsonb_each(w.cleanup_json) retry_resource WHERE retry_resource.value->>'state'='blocked'
   AND retry_resource.value->'workspace'->>'id'=w.id AND retry_resource.value->'workspace'->>'generation'=w.generation::text) AS retryable,
  w.state='blocked' OR EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.workspace_id=w.id AND b.change_set_id IN (SELECT c.id FROM workspace_change_sets c WHERE c.workspace_id=w.id AND c.generation=w.generation) AND b.checkpoint_state='blocked') AS blocked,
  EXISTS(SELECT 1 FROM jsonb_each(w.cleanup_json) resource WHERE resource.value->>'state'='blocked' AND COALESCE(resource.value->'workspace'->>'generation',w.generation::text)=w.generation::text
   AND NOT (COALESCE(resource.value->>'error','')=ANY($2::text[])) AND NOT (resource.value ? 'required_host_level')) AS cleanup_blocked,
  EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN workspace_change_sets c ON c.id=b.change_set_id
   JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.workspace_id=w.id AND c.generation=w.generation
   AND b.checkpoint_state='pending' AND NOT ${unlaunchedCheckpointSql('b','r')}) AS unsupported,
  EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
   WHERE b.workspace_id=w.id AND r.status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency')) AS active
  FROM execution_workspaces w WHERE w.id=$1`,[workspaceId,[...WORKSPACE_TEMPORARY_HOST_ERRORS]])).rows[0];
 return !r?'action_not_authorized':r.blocked?'checkpoint_blocked':r.cleanup_blocked&&mode!=='retry'?'workspace_discard_safety_blocked':r.active?'run_active':r.unsupported?'checkpoint_pending':mode==='retry'&&!r.retryable?'cleanup_not_retryable':null;
}
