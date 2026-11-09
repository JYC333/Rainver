import {LaunchWorkspaceSchema,HostLaunchWorkspaceAccessSchema,type ExecutionWorkspaceRef} from '@rainver/protocol';
import {runOutputResult} from '../runs/orchestrationResults.js';
import type {RunRecord} from '../runs/repository.js';
import type {Queryable} from '../routeUtils/common.js';
import type {ExecutionWorkspaceRow} from './executionWorkspaces.js';

/** The same frozen mount supplies both the verification recipe and its editor.
 * An attachment may belong to a different Folder than the Run's primary. */
export async function workspaceVerificationFolder(db:Queryable,w:Pick<ExecutionWorkspaceRow,'id'|'space_id'|'project_id'|'workspace_location_id'|'generation'>,origin:RunRecord){
 const output=runOutputResult(origin.output_json);
 const primary=LaunchWorkspaceSchema.safeParse(output.execution_workspace_location);
 const attachments=HostLaunchWorkspaceAccessSchema.array().safeParse(output.execution_workspace_access);
 if(!primary.success||!attachments.success)return null;
 const matches=(mount:{workspace_location_id:string;execution_workspace?:ExecutionWorkspaceRef})=>mount.workspace_location_id===w.workspace_location_id&&mount.execution_workspace?.id===w.id&&mount.execution_workspace.generation===w.generation;
 const original=primary.data.kind==='location'?primary.data:null;
 const isPrimary=original&&matches(original);
 const mount=isPrimary?original:attachments.data.find(matches);
 if(!mount)return null;
 const location=isPrimary?origin.workspace_location_id??mount.workspace_location_id:('mount_location_id' in mount?mount.mount_location_id:undefined)??mount.workspace_location_id;
 return (await db.query<{project_folder_id:string;name:string;status:string}>(`SELECT f.id AS project_folder_id,f.name,f.status FROM workspace_locations wl
  JOIN project_folders f ON f.id=wl.project_folder_id AND f.space_id=wl.space_id
  WHERE wl.id=$1 AND wl.space_id=$2 AND f.project_id=$3`,[location,w.space_id,w.project_id])).rows[0]??null;
}
