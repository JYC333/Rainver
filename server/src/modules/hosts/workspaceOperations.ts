import {DAEMON_WORKSPACE_OPERATION_SCHEMAS,type RegisteredSystemActionDefinition,type OperationActor} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationError,OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {lockActivePerson} from '../access/activePerson.js';
import {PgProjectFolderRepository} from '../projectFolders/repository.js';
import {PgWorkspaceLocationRepository} from '../projectFolders/workspaceLocations.js';
import {assertDaemonWorkspaceActor} from './workspaceActor.js';

type Target={project_id:string;folder_id?:string;space_id:string};
async function admit(db:Queryable,a:OperationActor,target:Target):Promise<void>{
 if(target.space_id!==a.space_id)throw hidden();
 const project=(await db.query<{status:string}>('SELECT status FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE',[target.project_id,target.space_id])).rows[0];
 if(!project)throw hidden();
 if(project.status!=='active')throw new OperationError('operation_conflict',409,false,'project_folders');
 await lockActivePerson(db,a.space_id,a.on_behalf_of_user_id!);
 await assertProjectWriterForMutation(db,a.space_id,target.project_id,a.on_behalf_of_user_id!);
 await assertDaemonWorkspaceActor(db,a,true);
 if(target.folder_id&&! (await db.query("SELECT id FROM project_folders WHERE id=$1 AND space_id=$2 AND project_id=$3 AND status='active' FOR UPDATE",[target.folder_id,a.space_id,target.project_id])).rows.length)throw hidden();
}
async function locationTarget(db:Queryable,a:OperationActor,location:string):Promise<Target>{
 const row=(await db.query<Target>(`SELECT pf.project_id,pf.id AS folder_id,pf.space_id FROM workspace_locations wl JOIN project_folders pf ON pf.id=wl.project_folder_id AND pf.space_id=wl.space_id WHERE wl.id=$1 AND wl.execution_host_id=$2 AND wl.execution_host_kind='remote'`,[location,a.principal.id])).rows[0];
 if(!row)throw hidden();return row;
}
export function daemonWorkspaceRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return Object.keys(DAEMON_WORKSPACE_OPERATION_SCHEMAS).map(id=>({
  definition:definitions.get(id)!,admission:{kind:'daemon_workspace'},domainAuthorizationFirst:true,successStatus:id==='host.workspace.create'?201:200,
  async resolve(_db,raw,a){const i=raw as {project_id?:string;location_id?:string};return {authority:id==='host.workspace.create'?`host:${a.principal.id}:project:${i.project_id}`:`host:${a.principal.id}:location:${i.location_id}`,targets:raw,resourceType:'host',resourceId:a.principal.id};},
  async authorize(db,raw,a){
   const input=raw as {project_id:string;location_id:string};
   const target=id==='host.workspace.create'?{space_id:a.space_id,project_id:input.project_id}:await locationTarget(db,a,input.location_id);
   await admit(db,a,target);
   if(id==='host.workspace.remove'){
    // Re-read after Project/person/Host/Folder roots. A moved or replaced target
    // conflicts before deletion; FK consumers retain their own restrictive gates.
    const current=await locationTarget(db,a,input.location_id);
    if(JSON.stringify(current)!==JSON.stringify(target))throw new OperationError('operation_conflict',409,false,'project_folders');
    await db.query('SELECT id FROM workspace_locations WHERE id=$1 FOR UPDATE',[input.location_id]);
   }
  },
  async authorizeResult(db,raw,a){
   const result=raw as Target&{host_id?:string};
   if(result.host_id&&result.host_id!==a.principal.id)throw hidden();
   await admit(db,a,result);
   if(id==='host.workspace.create'){
    const current=await locationTarget(db,a,(raw as {id:string}).id);
    if(current.project_id!==result.project_id||current.folder_id!==result.folder_id||current.space_id!==result.space_id)throw hidden();
   }
  },
  async execute(db,raw,a){
   const input=raw as {project_id:string;location_id:string;name:string;display_path?:string|null};
   if(id==='host.workspace.create'){
    const folders=new PgProjectFolderRepository(db,config);
    // Explicit deterministic duplicate, while holding the Project writer fence.
    if((await db.query("SELECT id FROM project_folders WHERE space_id=$1 AND project_id=$2 AND name=$3 AND status='active'",[a.space_id,input.project_id,input.name])).rows.length)throw new OperationBusinessError('operation_conflict',409,'project_folders');
    const result=await folders.createRemoteWorkspace(input.project_id,a.on_behalf_of_user_id!,a.principal.id,{name:input.name,displayPath:input.display_path??null});
    const location=await new PgWorkspaceLocationRepository(db).getRow(result.id);
    if(!location)throw new Error('Created workspace is absent');
    return {...result,space_id:a.space_id,folder_id:location.project_folder_id};
   }
   const target=await locationTarget(db,a,input.location_id);
   if(!await new PgWorkspaceLocationRepository(db).unregisterForHost(a.principal.id,input.location_id))throw hidden();
   return {...target,id:input.location_id,host_id:a.principal.id,removed:true};
  },
  classifyError(error){
   // PostgreSQL's actual restrictive references decide whether a single
   // Location can be removed. No Folder or consumer is deleted to make it fit.
   if((error as {code?:string}).code==='23503')return new OperationBusinessError('operation_conflict',409,'project_folders');
   return undefined;
  },
 }));
}
