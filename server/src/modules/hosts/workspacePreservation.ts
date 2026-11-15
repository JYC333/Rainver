import type {Queryable} from '../routeUtils/common.js';
/** Only a failed/cancelled temporary owner whose exact content was saved can
 * exchange its branch for a permanent recovery ref. No outcome is adopted. */
export async function canPreserveTemporarySource(db:Queryable,id:string,tip:string){
 return Boolean((await db.query(`SELECT 1 FROM execution_workspaces w WHERE w.id=$1 AND w.owner_kind='delegation' AND w.parent_workspace_id IS NOT NULL AND w.head_commit=$2
  AND w.state='ready' AND COALESCE((w.retention_json->>'hold_until')::timestamptz,'-infinity')<=now()
  AND EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.workspace_id=w.id AND b.checkpoint_commit=$2 AND r.status IN ('failed','cancelled','orphaned','degraded'))
  AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.workspace_id=w.id AND (b.checkpoint_state<>'saved' OR r.status NOT IN ('failed','cancelled','orphaned','degraded','succeeded')))
  AND NOT EXISTS(SELECT 1 FROM task_merges m WHERE m.workspace_id=w.id AND m.status IN ('queued','rebasing','resolving','verifying','waiting_local_changes'))
  AND NOT EXISTS(SELECT 1 FROM execution_workspaces child WHERE child.parent_workspace_id=w.id AND COALESCE(child.retention_json->>'state','')<>'reclaimed')`,[id,tip])).rowCount);
}
