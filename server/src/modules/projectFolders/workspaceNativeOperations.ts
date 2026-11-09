import {randomUUID} from 'node:crypto';
import {WorkspaceChangeCompleteInputSchema,WorkspaceChangeGetInputSchema,WorkspaceNativeProgressSchema,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {PgRunRepository} from '../runs/repository.js';
import type {ServerConfig} from '../../config.js';
import {dbPool} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError} from '../systemActions/operations/errors.js';
import {authorizedWorkspaceChange} from './workspaceOperations.js';
import {processNativeWorkspaceRequest} from '../hosts/workspaceNativeIntegration.js';

export function workspaceChangeGetRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {definition:definitions.get('workspace.change.get')!,readKind:'metadata',
  async resolve(db,raw,actor){const c=await authorizedWorkspaceChange(db,WorkspaceChangeGetInputSchema.parse(raw).change_set_id,actor,false,true,true);return {authority:`workspace:${c.workspace_id}`,targets:{workspace_id:c.workspace_id,change_set_id:c.id},resourceType:'project',resourceId:c.project_id};},
  async authorize(db,raw,actor){await authorizedWorkspaceChange(db,WorkspaceChangeGetInputSchema.parse(raw).change_set_id,actor,false,true,true);},
  async authorizeResult(db,raw,actor){await authorizedWorkspaceChange(db,(raw as {change_set_id:string}).change_set_id,actor,false,true,true);},
  async execute(db,raw,actor){
   const c=await authorizedWorkspaceChange(db,WorkspaceChangeGetInputSchema.parse(raw).change_set_id,actor,false,true,true);
   const row=(await db.query<{progress:unknown;integration_id:string|null}>(`SELECT c.verification_json->'native_progress' AS progress,m.id AS integration_id FROM workspace_change_sets c LEFT JOIN task_merges m ON m.change_set_id=c.id AND m.space_id=c.space_id WHERE c.id=$1 AND c.space_id=$2`,[c.id,actor.space_id])).rows[0]!;
   const progress=WorkspaceNativeProgressSchema.safeParse(row.progress);
   const origin=await new PgRunRepository(db).getVisibleRun(actor.space_id,actor.on_behalf_of_user_id!,c.originating_run_id);
   const target=(await db.query<{room_id:string|null;name:string;status:string|null;source_commit:string|null}>(`SELECT s.room_id,f.name,m.status,c.source_commit FROM workspace_change_sets c JOIN execution_workspaces w ON w.id=c.workspace_id AND w.space_id=c.space_id JOIN workspace_locations wl ON wl.id=w.workspace_location_id AND wl.space_id=c.space_id JOIN project_folders f ON f.id=wl.project_folder_id AND f.space_id=c.space_id AND f.project_id=w.project_id LEFT JOIN sessions s ON s.id=$2 AND s.space_id=c.space_id LEFT JOIN task_merges m ON m.change_set_id=c.id AND m.space_id=c.space_id WHERE c.id=$1`,[c.id,origin?.session_id??null])).rows[0];
   return {change_set_id:c.id,revision:c.revision,state:c.state,integration_id:row.integration_id,progress:progress.success?progress.data:null,
    can_retry:['open','blocked'].includes(c.state),integration_status:target?.status??null,conversation_id:origin?.session_id??null,room_id:target?.room_id??null,agent_id:origin?.agent_id??null,folder_name:target?.name??'',source_commit:target?.source_commit??null};
  },
 };
}
/** Admission is one Operation Core transaction; required Host work is a durable Job.
 * afterCommit is only a rebuildable kick of that same intent, outside the transaction. */
export function nativeWorkspaceRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):Pick<OperationRegistration,'execute'|'afterCommit'>&{retry:OperationRegistration['execute']}{
 async function admit(db:Queryable,raw:unknown,actor:OperationActor,actionId:string){
   const input=WorkspaceChangeCompleteInputSchema.parse(raw),c=await authorizedWorkspaceChange(db,input.change_set_id,actor,true,true);
   if(!actor.run_id)throw new OperationBusinessError('operation_invalid_input',422,'workspaces');
   const action=input.action??'prepare';
   if(c.revision!==input.expected_revision||!['open','ready','blocked','integrating'].includes(c.state))throw new OperationBusinessError('operation_conflict',409,'workspaces');
   const old=(await db.query<{progress:{status?:string}|null;request:{run_id?:string}|null}>("SELECT verification_json->'native_progress' AS progress,verification_json->'native_request' AS request FROM workspace_change_sets WHERE id=$1",[c.id])).rows[0];
   if(old?.progress?.status==='pending')throw new OperationBusinessError('operation_conflict',409,'workspaces');
   if(action==='publish'&&!input.verification)throw new OperationBusinessError('operation_invalid_input',422,'workspaces');
   const previous=(await db.query<{detail_json:Record<string,unknown>}>('SELECT detail_json FROM task_merges WHERE change_set_id=$1 FOR UPDATE',[c.id])).rows[0];
   if(input.commit&&previous)throw new OperationBusinessError('operation_conflict',409,'workspaces');
   const privateCheckpoint=action==='checkpoint'&&!previous;
   const id=randomUUID(),progress={request_id:id,action,status:'pending',commit:null,onto_commit:null,conflicted_files:[],error:null};
   await db.query(`UPDATE workspace_change_sets SET state=$5::varchar,revision=revision+1,summary=$2,completion_basis=$3,verification_json=verification_json||$4::jsonb,updated_at=now() WHERE id=$1`,[c.id,input.summary,privateCheckpoint?null:actor.run_id,JSON.stringify({native_request:{id,action,action_id:actionId,run_id:actor.run_id,user_id:actor.on_behalf_of_user_id,verification:input.verification??null,submitted_commit:input.commit??null},native_progress:progress}),privateCheckpoint?'open':'integrating']);
   if(previous)await db.query("UPDATE task_merges SET status='verifying',resolution_run_id=NULL,detail_json=detail_json||$2::jsonb WHERE change_set_id=$1",[c.id,JSON.stringify({native_integration:true,reply_owner_run_id:actor.run_id})]);
   await new PgJobQueueRepository(db).enqueue({job_type:'execution_workspace_native_integrate',space_id:actor.space_id,user_id:actor.on_behalf_of_user_id,payload:{change_set_id:c.id,request_id:id}});
   return {change_set_id:c.id,revision:c.revision+1,state:privateCheckpoint?'open':'integrating',integration_id:null,progress};
  }
 return {
  execute:(db,raw,actor)=>admit(db,raw,actor,'workspace.change.complete'),
  retry:(db,raw,actor)=>admit(db,raw,actor,'workspace.integration.retry'),
  async afterCommit(output,actor){const receipt=output as {change_set_id:string;progress?:{request_id:string}};if(receipt.progress)await processNativeWorkspaceRequest(dbPool(config),config,receipt.change_set_id,actor.space_id,receipt.progress.request_id);},
 };
}
