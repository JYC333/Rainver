import { PROJECT_FOLDER_SCHEMAS, type RegisteredSystemActionDefinition } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { OperationBusinessError, OperationError, hidden } from '../systemActions/operations/errors.js';
import { assertProjectWriter, assertProjectWriterForMutation } from '../projects/access.js';
import { PgProjectFolderRepository } from './repository.js';
import { ProjectFolderExecutionConfigRepository } from '../projectFolderExecutionConfigs/repository.js';
import { ProjectFolderMutationError,projectFolderRefusal } from './operationErrors.js';
import {lockProjectFileDraftQuota} from './draftRepository.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {PROJECT_FOLDER_FORGET_JOB} from './forgetWorkspaceJob.js';
type Input = { project_id: string; folder_id: string; location_id?: string; validation_recipe_id?: string | null; workspace_location_id?:string|null;draft_id?:string;draft_version?:number };
export function projectFolderRegistrations(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>, config: ServerConfig): OperationRegistration[] {
  return Object.keys(PROJECT_FOLDER_SCHEMAS).map(id => ({
    definition: definitions.get(id)!, successStatus: id === 'project.folder.execution_config.create' ? 201 : 200,
    async resolve(db, raw,actor) { const input=raw as Input;
      const location=id==='project.folder.draft.upsert'?(await db.query<{id:string}>("SELECT id FROM workspace_locations WHERE space_id=$1 AND project_folder_id=$2 AND status='active'",[actor.space_id,input.folder_id])).rows[0]?.id:null;
      if(id==='project.folder.draft.upsert'&&!location)throw hidden();
      return { authority:`project:${input.project_id}`,targets:{project_id:input.project_id,folder_id:input.folder_id,...(id==='project.folder.draft.upsert'?{workspace_location_id:input.workspace_location_id??location}:{})},resourceType:'project',resourceId:input.project_id }; },
    async authorize(db, raw, actor,scope) {
      const input=raw as Input, user=actor.on_behalf_of_user_id!;
      await assertProjectWriter(db,actor.space_id,input.project_id,user,{allowArchived:true});
      const project=(await db.query<{status:string}>('SELECT status FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE',[input.project_id,actor.space_id])).rows[0];
      if(!project)throw hidden();
      await assertProjectWriterForMutation(db,actor.space_id,input.project_id,user);
      if(!['project.folder.update','project.folder.archive','project.folder.unregister'].includes(id)&&project.status!=='active')throw new OperationError('operation_conflict',409,false,'project_folders');
      const folder=(await db.query<{status:string}>('SELECT status FROM project_folders WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[input.folder_id,actor.space_id,input.project_id])).rows[0];
      if(!folder&&id!=='project.folder.unregister')throw hidden();
      if(id.startsWith('project.folder.draft.')&&folder?.status!=='active')throw hidden();
      if(id==='project.folder.draft.upsert'){
        const location=(scope.targets as {workspace_location_id:string}).workspace_location_id;
        if(!(await db.query("SELECT id FROM workspace_locations WHERE id=$1 AND space_id=$2 AND project_folder_id=$3 AND status='active' FOR SHARE",[location,actor.space_id,input.folder_id])).rows.length)throw new OperationError('operation_conflict',409,false,'project_folders');
        await lockProjectFileDraftQuota(db,actor.space_id,user);
      }
      if(id==='project.folder.draft.discard'){
        await lockProjectFileDraftQuota(db,actor.space_id,user);
        await db.query('SELECT id FROM project_file_drafts WHERE id=$1 AND space_id=$2 AND project_folder_id=$3 AND owner_user_id=$4 FOR UPDATE',[input.draft_id,actor.space_id,input.folder_id,user]);
      }
      if(input.location_id){
        const location=(await db.query<{execution_host_id:string}>('SELECT execution_host_id FROM workspace_locations WHERE id=$1 AND space_id=$2 AND project_folder_id=$3',[input.location_id,actor.space_id,input.folder_id])).rows[0];
        if(!location)throw hidden();
        const host=(await db.query<{kind:string;owner_user_id:string|null}>('SELECT kind,owner_user_id FROM hosts WHERE id=$1 FOR SHARE',[location.execution_host_id])).rows[0];
        if(!host||(host.kind==='remote'&&host.owner_user_id!==user))throw hidden();
        await db.query('SELECT id FROM workspace_locations WHERE space_id=$1 AND project_folder_id=$2 ORDER BY id FOR UPDATE',[actor.space_id,input.folder_id]);
      }
      if(input.validation_recipe_id&&!(await db.query('SELECT id FROM validation_recipes WHERE id=$1 AND space_id=$2 FOR SHARE',[input.validation_recipe_id,actor.space_id])).rows.length)throw hidden();
      if(id.startsWith('project.folder.execution_config.'))await db.query('SELECT id FROM project_folder_execution_configs WHERE space_id=$1 AND project_folder_id=$2 FOR UPDATE',[actor.space_id,input.folder_id]);
    },
    async authorizeResult(db, raw, actor){const result=raw as {space_id:string;project_id:string;folder_id:string};if(result.space_id!==actor.space_id)throw hidden();await assertProjectWriterForMutation(db,actor.space_id,result.project_id,actor.on_behalf_of_user_id!);},
    async execute(db,raw,actor){
      const input=raw as Input,body=raw as Record<string,unknown>,identity={spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!},folders=new PgProjectFolderRepository(db,config),configs=new ProjectFolderExecutionConfigRepository(db);
      let targetId=input.folder_id;
      switch(id){
        case 'project.folder.draft.upsert':{
          const result=await folders.upsertDraft(identity,input.project_id,input.folder_id,body);
          return {id:result.id,space_id:actor.space_id,project_id:input.project_id,folder_id:input.folder_id,workspace_location_id:result.workspace_location_id,version:result.version};
        }
        case 'project.folder.draft.discard':await folders.discardDraft(identity,input.project_id,input.folder_id,body);targetId=input.draft_id!;break;
        case 'project.folder.unregister':{
          if(!(await db.query('SELECT id FROM project_folders WHERE id=$1 AND space_id=$2 AND project_id=$3',[input.folder_id,actor.space_id,input.project_id])).rows.length)throw hidden();
          const locations=await db.query<{id:string;execution_host_id:string}>("SELECT id,execution_host_id FROM workspace_locations WHERE space_id=$1 AND project_folder_id=$2 AND execution_host_kind='remote' ORDER BY id FOR UPDATE",[actor.space_id,input.folder_id]);
          if(!await folders.unregister(identity,input.project_id,input.folder_id,{confirm:body.confirm===true}))throw hidden();
          for(const location of locations.rows)await new PgJobQueueRepository(db).enqueue({job_type:PROJECT_FOLDER_FORGET_JOB,space_id:actor.space_id,user_id:identity.userId,payload:{project_id:input.project_id,folder_id:input.folder_id,workspace_location_id:location.id,host_id:location.execution_host_id}});
          break;
        }
        case 'project.folder.update':if(!await folders.update(identity,input.project_id,input.folder_id,body))throw hidden();break;
        case 'project.folder.archive':if(!await folders.archive(identity,input.project_id,input.folder_id))throw hidden();break;
        case 'project.folder.location.activate':targetId=(await folders.activateLocation(identity,input.project_id,input.folder_id,input.location_id!)).id;break;
        case 'project.folder.execution_config.create':targetId=(await configs.create(identity,input.project_id,input.folder_id,body)).id as string;break;
        case 'project.folder.execution_config.update':targetId=(await configs.update(identity,input.project_id,input.folder_id,body)).id as string;break;
        default:throw new Error('Unknown Project Folder operation');
      }
      return {id:targetId,space_id:actor.space_id,project_id:input.project_id,folder_id:input.folder_id};
    },
    classifyError(error){
      const refusal=projectFolderRefusal(error);if(refusal)return refusal;
      if(error instanceof ProjectFolderMutationError)return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode===409?409:422,'project_folders');
      if((error as {code?:string;constraint?:string}).code==='23505'&&(error as {constraint?:string}).constraint==='uq_project_folder_execution_configs_project_folder')return new OperationBusinessError('operation_conflict',409,'project_folders');
      return undefined;
    },
  }));
}
