import type {ExecutionWorkspaceRef} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {workspaceReference,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {loadTaskLocation,locationWorkspace,taskLocationUsable} from './taskBranchRequests.js';

/** Same validated Location translation as legacy Task frames, with a generic owner. */
export async function workspaceLocationFrame(db:Queryable,w:ExecutionWorkspaceRow,ref:ExecutionWorkspaceRef=workspaceReference(w),workspaceRoot?:string,userId?:string){
 const location=await loadTaskLocation(db,w.workspace_location_id,w.space_id);
 if(!taskLocationUsable(location)||location.execution_host_id!==w.execution_host_id)throw new Error('execution_workspace_location_unavailable');
 if(location.execution_host_kind==='server'&&location.root_path&&!workspaceRoot)throw new Error('execution_workspace_shared_root_required');
 const host=(await db.query<{kind:string;owner_user_id:string|null;capabilities_json:{execution_workspaces?:{version:number}}}>('SELECT kind,owner_user_id,capabilities_json FROM hosts WHERE id=$1',[w.execution_host_id])).rows[0];
 if(userId&&(!host||host.kind==='remote'&&host.owner_user_id!==userId))throw new Error('execution_workspace_host_authority_changed');
 if(host?.capabilities_json?.execution_workspaces?.version!==2)throw new Error('execution_workspace_host_upgrade_required');
 const launch=locationWorkspace(location,workspaceRoot??'/');
 if(!launch)throw new Error('execution_workspace_location_outside_root');
 return {...launch,execution_workspace:ref};
}

/** Profile containers are addressed by identity, independently of source Git. */
export async function workspaceProfileFrame(db:Queryable,w:ExecutionWorkspaceRow,ref:ExecutionWorkspaceRef,userId:string){
 if(ref.id!==w.id||ref.generation!==w.generation)throw new Error('execution_workspace_profile_identity_mismatch');
 const current=(await db.query<{kind:string;owner_user_id:string|null;capabilities_json:{execution_workspaces?:{version:number}}}>(`SELECT h.kind,h.owner_user_id,h.capabilities_json
  FROM execution_workspaces w JOIN hosts h ON h.id=w.execution_host_id
  WHERE w.id=$1 AND w.space_id=$2 AND w.generation=$3 AND w.execution_host_id=$4
   AND w.workspace_location_id=$5 AND h.status<>'revoked'`,[w.id,w.space_id,ref.generation,w.execution_host_id,w.workspace_location_id])).rows[0];
 if(!current||current.kind==='remote'&&current.owner_user_id!==userId)throw new Error('execution_workspace_host_authority_changed');
 if(current.capabilities_json?.execution_workspaces?.version!==2)throw new Error('execution_workspace_host_upgrade_required');
 return {kind:'location' as const,workspace_location_id:w.workspace_location_id,execution_workspace:ref};
}
