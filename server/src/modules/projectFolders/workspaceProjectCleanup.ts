import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';

/** Inspection/closure only, never publication or runtime placement. The caller
 * is the person's manually instructed conversation writer in this Project;
 * target visibility, contributors and Host ownership are checked by the shared
 * workspace authorizer. Mutation still requires canonical instruction provenance
 * and an exact-source review through workspace.change.abandon. */
export async function projectWorkspaceCleanupAccess(db:Queryable,actor:OperationActor,target:{project_id:string;owner_kind:string},originUserId:string|null){
 if(!actor.run_id||!actor.on_behalf_of_user_id||originUserId!==actor.on_behalf_of_user_id
  ||!['conversation','delegation'].includes(target.owner_kind))return false;
 return Boolean((await db.query(`SELECT 1 FROM runs r
  JOIN execution_workspace_runs b ON b.run_id=r.id AND b.space_id=r.space_id AND b.access_mode='write'
  JOIN execution_workspaces w ON w.id=b.workspace_id AND w.space_id=b.space_id
  WHERE r.id=$1 AND r.space_id=$2 AND r.project_id=$3 AND r.instructed_by_user_id=$4
   AND r.trigger_origin='manual' AND r.delegation_id IS NULL
   AND w.owner_kind='conversation' AND w.session_id=r.session_id AND w.project_id=r.project_id
  LIMIT 1`,[actor.run_id,actor.space_id,target.project_id,actor.on_behalf_of_user_id])).rowCount);
}
