import {refreshCleanupSummary} from './workspaceCleanup.js';
import type {Queryable} from '../routeUtils/common.js';
import type {ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {closedCheckpointHistorySql} from '../projectFolders/workspaceReleaseState.js';

/** The admission path takes this same row lock. A Host read never carries
 * authority across a new binding, release epoch or owner revision. */
export async function lockWorkspaceObservation(tx:Queryable,w:ExecutionWorkspaceRow&{materialization_epoch:number}){
 const current=(await tx.query<ExecutionWorkspaceRow&{materialization_epoch:number}>(`SELECT * FROM execution_workspaces WHERE id=$1 FOR UPDATE`,[w.id])).rows[0];
 if(!current||current.revision!==w.revision||current.state!==w.state||current.materialization_epoch!==w.materialization_epoch)return false;
 const live=(await tx.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=$1
  AND r.status NOT IN ('succeeded','failed','degraded','cancelled','orphaned')
  UNION ALL SELECT 1 FROM execution_workspace_reviews v JOIN runs r ON r.id=v.run_id WHERE v.workspace_id=$1
  AND r.status NOT IN ('succeeded','failed','degraded','cancelled','orphaned') LIMIT 1`,[w.id])).rowCount;
 if(live)return false;
 return true;
}

export async function lockUnchangedIdleWorkspace(tx:Queryable,w:ExecutionWorkspaceRow&{materialization_epoch:number}){
 if(!await lockWorkspaceObservation(tx,w))return false;
 const historical=(await tx.query(`SELECT 1 FROM execution_workspaces w WHERE w.id=$1 AND ${closedCheckpointHistorySql('w')}`,[w.id])).rowCount;
 const checkpoints=(await tx.query<{blocked:boolean;pending:boolean}>(`SELECT bool_or(checkpoint_state='blocked') AS blocked,bool_or(checkpoint_state<>'saved') AS pending FROM execution_workspace_runs WHERE workspace_id=$1`,[w.id])).rows[0];
 if(checkpoints?.blocked&&!historical){
  await tx.query(`UPDATE execution_workspaces SET cleanup_state='blocked',inventory_json=inventory_json||jsonb_build_object('checkpoint_reconciliation_failed_at',COALESCE(inventory_json->'checkpoint_reconciliation_failed_at',to_jsonb(now())))||CASE WHEN inventory_json->>'reconciliation_error' IS NULL OR inventory_json->>'reconciliation_error'='workspace_checkpoint_blocked' THEN jsonb_build_object('reconciliation_error','workspace_checkpoint_blocked','reconciliation_failed_at',COALESCE(inventory_json->'reconciliation_failed_at',to_jsonb(now()))) ELSE '{}'::jsonb END WHERE id=$1`,[w.id]);
  return false;
 }
 if(checkpoints?.pending&&!historical)return false;
 // Saved checkpoint evidence or a fenced closed-history receipt can clear this diagnostic. An unrelated
 // inspection failure remains owned by its existing recovery path.
 const cleared=await tx.query(`UPDATE execution_workspaces SET inventory_json=(inventory_json-'checkpoint_reconciliation_failed_at')-CASE WHEN inventory_json->>'reconciliation_error'='workspace_checkpoint_blocked' THEN ARRAY['reconciliation_error','reconciliation_failed_at'] ELSE ARRAY[]::text[] END WHERE id=$1 AND (inventory_json ? 'checkpoint_reconciliation_failed_at' OR inventory_json->>'reconciliation_error'='workspace_checkpoint_blocked')`,[w.id]);
 if(cleared.rowCount)await refreshCleanupSummary(tx,w.id);
 return true;
}

/** Read-only Host inventory is allowed even when checkpoint recovery refused.
 * A closed, absent source becomes history; its original failed bindings remain
 * intact. This receipt authorizes no checkpoint, ref deletion or new execution. */
export async function recordClosedCheckpointHistory(tx:Queryable,w:ExecutionWorkspaceRow&{materialization_epoch:number},inventory:Record<string,unknown>){
 if(!await lockWorkspaceObservation(tx,w))return false;
 const observed={...inventory,checkpoint_history_generation:w.generation,checkpoint_history_epoch:w.materialization_epoch,checkpoint_history_closed_at:new Date().toISOString()};
 const result=await tx.query(`UPDATE execution_workspaces w SET inventory_json=$2::jsonb,
  retention_json=retention_json||jsonb_build_object('state','retained','reason','kept_without_merging','assessed_at',now())
  WHERE w.id=$1 AND ${closedCheckpointHistorySql('w','($2::jsonb)')}`,[w.id,JSON.stringify(observed)]);
 if(result.rowCount)await refreshCleanupSummary(tx,w.id);
 return Boolean(result.rowCount);
}
