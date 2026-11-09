import type {ExecutionWorkspaceRef,LaunchWorkspace} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {loadTaskLocation,locationWorkspace,taskLocationUsable} from './taskBranchRequests.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from './connectionRegistry.js';

/** Normalize aliases through the owning Host, restricted to frozen Run grants. */
export async function resolveWorkspaceScope(db:Queryable,spaceId:string,projectId:string,hostId:string,locationId:string,grantedIds:string[],workspaceRoot:string,hosts:HostConnectionRegistry=sharedHostConnectionRegistry,sessionId?:string|null){
 const candidates:Extract<LaunchWorkspace,{kind:'location'}>[]=[];
 for(const id of [...new Set(grantedIds)].sort()){
  const location=await loadTaskLocation(db,id,spaceId);
  const owned=(await db.query('SELECT 1 FROM workspace_locations wl JOIN project_folders f ON f.id=wl.project_folder_id WHERE wl.id=$1 AND wl.space_id=$2 AND f.project_id=$3',[id,spaceId,projectId])).rowCount;
  if(!owned||!taskLocationUsable(location)||location.execution_host_id!==hostId)throw new Error('workspace_scope_grant_unavailable');
  const frame=locationWorkspace(location,workspaceRoot);if(!frame)throw new Error('workspace_scope_grant_outside_root');
  candidates.push(frame);
 }
 const workspace=candidates.find(c=>c.workspace_location_id===locationId);
 if(!workspace)throw new Error('workspace_scope_not_granted');
 const prior=sessionId?(await db.query<{workspace_location_id:string}>("SELECT workspace_location_id FROM execution_workspaces WHERE session_id=$1 AND space_id=$2 AND execution_host_id=$3 AND state<>'retired' AND owner_kind='conversation' AND workspace_location_id=ANY($4::varchar[]) ORDER BY created_at LIMIT 1",[sessionId,spaceId,hostId,grantedIds])).rows[0]:null;
 const reply=await hosts.requestTaskBranch(hostId,'workspace_scope',{workspace,candidates,...(prior?{preferred_location_id:prior.workspace_location_id}:{})});
 if(!reply.ok||!reply.root_location_id||reply.cwd_subpath===null)throw new Error(reply.error??'workspace_scope_unavailable');
 const canonical=candidates.find(c=>c.workspace_location_id===reply.root_location_id);
 if(!canonical||reply.cwd_subpath.startsWith('/')||reply.cwd_subpath.includes('\\')||reply.cwd_subpath.split('/').some(p=>p==='..'||p==='.'))throw new Error('workspace_scope_invalid_host_reply');
 return {workspace:canonical,locationId:reply.root_location_id,subpath:reply.cwd_subpath};
}

/** Mount paths belong to this grant, not to a reused workspace/run receipt. */
export function executionWorkspaceMountRef(ref:ExecutionWorkspaceRef,subpath?:string|null):ExecutionWorkspaceRef{
 const mounted={...ref};
 delete mounted.cwd_subpath;
 if(subpath)mounted.cwd_subpath=subpath;
 return mounted;
}
