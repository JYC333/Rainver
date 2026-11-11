import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {OperationBusinessError} from '../systemActions/operations/errors.js';
import {replaceableSourceCleanup,type WorkspaceCleanupResource} from '../hosts/workspaceCleanup.js';

/** Caller already holds the workspace/batch locks and passed the ordinary close authorizer.
 * A review is not adoption: it authorizes abandoning this exact saved generation only.
 * Never transfer it to a newer checkpoint, unsaved binding or active child. */
export async function admitWorkspaceDiscard(db:Queryable,c:{id:string;workspace_id:string;generation:number},source:string,actor:OperationActor){
 const w=(await db.query<{generation:number;head_commit:string|null;state:string;cleanup_json:Record<string,WorkspaceCleanupResource>;level:number|null}>(`SELECT w.generation,w.head_commit,w.state,w.cleanup_json,(h.capabilities_json->'execution_workspaces'->>'reclaim')::int AS level
  FROM execution_workspaces w JOIN hosts h ON h.id=w.execution_host_id WHERE w.id=$1`,[c.workspace_id])).rows[0];
 const refuse=()=>{throw new OperationBusinessError('operation_conflict',409,'workspaces');};
 if(!w||w.generation!==c.generation||w.head_commit!==source||w.state==='blocked'||(w.level??0)<5)refuse();
 if(!replaceableSourceCleanup(w!.cleanup_json[`source-g${c.generation}`]))refuse();
 if((await db.query(`SELECT 1 WHERE
  EXISTS(SELECT 1 FROM workspace_change_sets WHERE workspace_id=$1 AND id<>$2 AND state IN ('open','ready','integrating','blocked')) OR
  EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=$1 AND
    (b.checkpoint_state<>'saved' OR r.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review'))) OR
  EXISTS(SELECT 1 FROM task_merges WHERE workspace_id=$1 AND status IN ('queued','rebasing','resolving','verifying','waiting_local_changes'))`,[c.workspace_id,c.id])).rowCount)refuse();
 return {generation:c.generation,source_commit:source,change_set_id:c.id,user_id:actor.on_behalf_of_user_id,run_id:actor.run_id,requested_at:new Date().toISOString()};
}
