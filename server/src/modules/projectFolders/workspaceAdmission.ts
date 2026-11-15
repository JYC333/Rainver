import type {ServerConfig} from '../../config.js';
import type {RunRecord} from '../runs/runRepositoryTypes.js';
import type {Queryable} from '../routeUtils/common.js';
import {resolveWorkspaceScope} from '../hosts/workspaceScopes.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from '../hosts/connectionRegistry.js';
import {ensurePrimaryExecutionWorkspace,isolatedWorkspaceContract} from './executionWorkspaces.js';

/** The same canonical grants feed admission and dispatch; aliases never widen access. */
export async function canonicalExecutionWorkspaceScopes(db:Queryable,run:RunRecord,hostId:string,workspaceLocationId:string|null,
 access:ReadonlyArray<{workspace_location_id:string;access_mode:'read'|'write'}>,workspaceRoot:string,registry:HostConnectionRegistry=sharedHostConnectionRegistry){
 const normalizedScopes=new Map<string,Awaited<ReturnType<typeof resolveWorkspaceScope>>>();
 const canonicalGrants=new Map<string,'read'|'write'>();
 const originalGrants=[...(workspaceLocationId?[{id:workspaceLocationId,access:(run.contract_snapshot_json as {workspace_access?:string}).workspace_access==='read'?'read' as const:'write' as const}]:[]),...access.map(a=>({id:a.workspace_location_id,access:(run.contract_snapshot_json as {workspace_access?:string}).workspace_access==='read'?'read' as const:a.access_mode}))];
 for(const grant of originalGrants){
  const scope=await resolveWorkspaceScope(db,run.space_id,run.project_id!,hostId,grant.id,originalGrants.map(g=>g.id),workspaceRoot,registry,run.session_id);
  const rootGrant=originalGrants.find(g=>g.id===scope.locationId);
  if(grant.access==='write'&&rootGrant?.access!=='write')throw new Error('workspace_subdirectory_requires_writable_repository_root');
  const previous=canonicalGrants.get(scope.locationId);
  if(previous&&previous!==grant.access)throw new Error('workspace_alias_permissions_conflict');
  canonicalGrants.set(scope.locationId,grant.access);normalizedScopes.set(grant.id,scope);
 }
 return {normalizedScopes,canonicalGrants};
}

/** Reserve the delegated primary before Run/attempt/delegation become running.
 * Binding is durable and idempotent; dispatch rechecks current permissions and
 * uses this exact binding. Native integration repair keeps its special owner.
 */
export async function admitDelegatedExecutionWorkspace(db:Queryable,run:RunRecord,port:{hostId?:string;workspaceLocationId?:string|null;workspaceAccess?:ReadonlyArray<{workspace_location_id:string;access_mode:'read'|'write'}>},config:ServerConfig,registry?:HostConnectionRegistry){
 if(!run.delegation_id||!isolatedWorkspaceContract(run.contract_snapshot_json)||!port.hostId||!port.workspaceLocationId
  ||(run.contract_snapshot_json as {workspace_integration_id?:string}).workspace_integration_id)return;
 const {normalizedScopes}=await canonicalExecutionWorkspaceScopes(db,run,port.hostId,port.workspaceLocationId,port.workspaceAccess??[],config.workspaceRoot,registry);
 await ensurePrimaryExecutionWorkspace(db,run,port.hostId,normalizedScopes.get(port.workspaceLocationId)?.locationId??port.workspaceLocationId);
}
