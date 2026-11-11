import {z} from 'zod';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import {JobDeferredError,type JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from '../hosts/connectionRegistry.js';
export const PROJECT_FOLDER_FORGET_JOB='project_folder_workspace_forget';
const id=z.string().min(1).max(36);
const payloadSchema=z.object({project_id:id,folder_id:id,workspace_location_id:id,host_id:id}).strict();
/** Frozen cleanup only: forget an already-deleted registration; never remove a directory. */
export function registerProjectFolderForgetHandler(registry:JobHandlerRegistry,config:ServerConfig,hosts:Pick<HostConnectionRegistry,'forgetHostWorkspace'>=sharedHostConnectionRegistry):void{
  registry.register(PROJECT_FOLDER_FORGET_JOB,async job=>{
    if(!config.databaseUrl)throw new Error('Folder cleanup requires a database');
    const payload=payloadSchema.parse(job.payload),db=getDbPool(config.databaseUrl);
    // A live registration always wins. The Job cannot remove any newly restored/recreated mapping.
    if((await db.query('SELECT id FROM workspace_locations WHERE id=$1',[payload.workspace_location_id])).rows.length)return {forgotten:false,reason:'registration_exists'};
    const answer=await hosts.forgetHostWorkspace(payload.host_id,payload.workspace_location_id);
    if(!answer.ok){
      if(['host_offline','host_disconnected','host_timeout'].includes(answer.error??''))throw new JobDeferredError('Folder registration cleanup is waiting for its Host',30000);
      throw new Error('Folder registration cleanup was refused');
    }
    return {forgotten:true};
  });
}
