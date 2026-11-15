import type {Queryable} from '../routeUtils/common.js';
import {childSourceHeldSql} from './workspaceReleaseState.js';
import {unlaunchedCheckpointSql} from './workspaceCheckpointState.js';
import {cleanupPublicationStatus,nativeWorkspaceBusySql} from './workspacePublicationState.js';

/** One predicate for read projection, admission and the locked release recheck.
 * Admission alone may defer terminal unlaunched checkpoint proof to cleanup. */
export function workspaceDiscardDependenciesSql(workspace:string,change:string,settleLegacy='false',deferUnlaunched=true){
 return `(
  EXISTS(SELECT 1 FROM workspace_change_sets WHERE workspace_id=${workspace} AND id<>${change} AND state IN ('open','ready','integrating','blocked')) OR
  EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=${workspace} AND
    ((b.checkpoint_state<>'saved' ${deferUnlaunched?`AND NOT ${unlaunchedCheckpointSql('b','r')}`:''}) OR r.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review'))) OR
  EXISTS(SELECT 1 FROM task_merges WHERE workspace_id=${workspace} AND status IN ('queued','rebasing','resolving','verifying','waiting_local_changes') AND NOT (${settleLegacy} AND change_set_id=${change} AND status='verifying')) OR
  EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=${workspace} AND (c.verification_json->'native_progress'->>'status'='pending' OR ${nativeWorkspaceBusySql('c')})) OR
  EXISTS(SELECT 1 FROM jobs j WHERE j.status IN ('pending','claimed','running') AND
   ((j.job_type='task_merge' AND EXISTS(SELECT 1 FROM task_merges m WHERE m.workspace_id=${workspace} AND m.id=j.payload_json->>'merge_id')) OR
    (j.job_type='execution_workspace_native_integrate' AND EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=${workspace} AND c.id=j.payload_json->>'change_set_id')))) OR
  EXISTS(SELECT 1 FROM execution_workspace_reviews v JOIN runs r ON r.id=v.run_id WHERE v.workspace_id=${workspace} AND r.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review')) OR
  EXISTS(SELECT 1 FROM execution_workspaces child WHERE child.parent_workspace_id=${workspace} AND (
   ${childSourceHeldSql('child')} OR
   EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=child.id AND c.state IN ('open','ready','integrating','blocked')) OR
   EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=child.id AND r.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review')))))`;
}
export async function workspaceDiscardDependenciesActive(db:Queryable,workspaceId:string,changeId:string,deferUnlaunched=true){
 const publication=changeId?await cleanupPublicationStatus(db,changeId):{settleLegacy:false};
 return Boolean((await db.query(`SELECT 1 WHERE ${workspaceDiscardDependenciesSql('$1','$2','$3::boolean',deferUnlaunched)}`,[workspaceId,changeId,publication.settleLegacy])).rowCount);
}
