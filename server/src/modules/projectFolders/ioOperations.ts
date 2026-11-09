import {createHash,randomUUID} from 'node:crypto';
import {PROJECT_FOLDER_IO_SCHEMAS,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {canonical} from '../systemActions/operations/repository.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {PgProjectFolderRepository} from './repository.js';
import {folderIoKind,discoverFolderIo,lockFolderIoAuthority} from './ioAdmission.js';
import {loadFolderIoIntent,FolderIoRefusal} from './ioIntentRepository.js';
import {ProjectFolderMutationError} from './operationErrors.js';
import {terminalFolderIoProjection} from './ioTerminalProjection.js';
export const PROJECT_FOLDER_IO_JOB='project_folder_io';
function refusal(error:FolderIoRefusal){
  if(error.code==='operation_not_found')return hidden();
  const failure=new OperationBusinessError(error.code==='operation_invalid_input'? 'operation_invalid_input':'operation_conflict',error.code==='operation_invalid_input'?422:409,'project_folders'),body=failure.body.bind(failure);
  failure.body=requestId=>{const result=body(requestId);result.error.metadata={code:error.code,...error.metadata};return result;};return failure;
}
export function projectFolderIoRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return Object.keys(PROJECT_FOLDER_IO_SCHEMAS).map(operation=>({
    definition:definitions.get(operation)!,successStatus:202,
    async resolve(_db,raw){const input=raw as Record<string,unknown>;return{authority:`project:${input.project_id}`,targets:{project_id:input.project_id,folder_id:input.folder_id??null},resourceType:operation==='project.folder.draft.save'?'project_folder':'project',resourceId:String(input.folder_id??input.project_id)};},
    async authorize(db,raw,actor){
      const input=raw as Record<string,unknown>,user=actor.on_behalf_of_user_id!;
      await assertProjectWriter(db,actor.space_id,String(input.project_id),user,{allowArchived:true});
      try{await lockActiveProjectForMutation(db,actor.space_id,String(input.project_id));}catch(error){if(error instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409);throw error;}
      await assertProjectWriterForMutation(db,actor.space_id,String(input.project_id),user);
      if(input.folder_id){await db.query('SELECT id FROM project_folders WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[input.folder_id,actor.space_id,input.project_id]);await new PgProjectFolderRepository(db,config).writableFolderForIo({spaceId:actor.space_id,userId:user},String(input.project_id),String(input.folder_id));}
      // Admission owns the Folder. Frozen private-source and Host checks run in
      // its canonical domain writer; replay does not require a consumed draft.
    },
    async authorizeResult(db,raw,actor){const result=raw as{id:string;space_id:string;project_id:string};if(result.space_id!==actor.space_id)throw hidden();const intent=await loadFolderIoIntent(db,result.id,actor.space_id);if(intent.user_id!==actor.on_behalf_of_user_id||intent.project_id!==result.project_id)throw hidden();await assertProjectWriterForMutation(db,actor.space_id,intent.project_id,actor.on_behalf_of_user_id!);},
    policyContext(){return{trigger_origin:'manual',direct_user_write:true,file_operation:'write'};},
    async execute(db,raw,actor){
      const input=raw as Record<string,unknown>,kind=folderIoKind(operation),user=actor.on_behalf_of_user_id!,project=String(input.project_id);
      try{
        const source=await discoverFolderIo(db,kind,input,actor.space_id,user),frozen=await lockFolderIoAuthority(db,config,kind,input,actor.space_id,user,source);
        const key=kind==='create'?{kind,name:input.name}:kind==='scan'?{kind,user}:{folder:input.folder_id,location:frozen.location!.id,path:frozen.draft?.relative_path??frozen.revision!.path};
        const scope=createHash('sha256').update(canonical(key)).digest('hex');
        let active:{id:string;user_id:string;status:string}|undefined=(await db.query<{id:string;user_id:string;status:string}>("SELECT id,user_id,status FROM project_folder_io_intents WHERE space_id=$1 AND project_id=$2 AND scope_key=$3 AND status IN ('pending','prepared','applied','needs_attention') FOR UPDATE",[actor.space_id,project,scope])).rows[0];
        if(active&&active.status!=='needs_attention'){
          const previous=await loadFolderIoIntent(db,active.id,actor.space_id),job=(await db.query<{status:string}>('SELECT status FROM jobs WHERE id=$1',[previous.job_id])).rows[0];
          if(job&&['cancelled','failed'].includes(job.status)){
            // A terminal Job cannot acquire another lease. Before any external
            // effect the worker durably records its marker under that lease.
            const effect=previous.effect_json,importEffect=effect.import as{directoryStarted?:boolean}|undefined,attention=Boolean(effect.write_started||effect.applied||importEffect?.directoryStarted);
            const projection=attention?{frozen:previous.frozen_json,effect}:terminalFolderIoProjection(previous,effect);
            await db.query('UPDATE project_folder_io_intents SET status=$2,error_code=$3,frozen_json=$4::jsonb,effect_json=$5::jsonb,updated_at=now() WHERE id=$1',[previous.id,attention?'needs_attention':'failed','folder_job_'+job.status,JSON.stringify(projection.frozen),JSON.stringify(projection.effect)]);
            active=attention?{...active,status:'needs_attention'}:undefined;
          }
        }
        if(active)throw new FolderIoRefusal(active.status==='needs_attention'?'folder_io_needs_attention':'folder_io_busy',active.user_id===user?{intent_id:active.id}:{});
        const id=randomUUID();
        await db.query("INSERT INTO project_folder_io_intents(id,space_id,project_id,user_id,folder_id,kind,scope_key,status,frozen_json,effect_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8::jsonb,'{}'::jsonb,now(),now())",[id,actor.space_id,project,user,input.folder_id??null,kind,scope,JSON.stringify(frozen)]);
        const job=await new PgJobQueueRepository(db).enqueue({job_type:PROJECT_FOLDER_IO_JOB,space_id:actor.space_id,user_id:user,payload:{intent_id:id},max_attempts:5});
        await db.query('UPDATE project_folder_io_intents SET job_id=$2 WHERE id=$1',[id,job.id]);
        return{id,space_id:actor.space_id,project_id:project,folder_id:input.folder_id??null,job_id:job.id};
      }catch(error){if(error instanceof FolderIoRefusal)throw refusal(error);throw error;}
    },
    classifyError(error){if(error instanceof ProjectFolderMutationError)return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode===409?409:422,'project_folders');return undefined;},
  }));
}
