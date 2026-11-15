import {SOURCE_RETRIEVAL_JOB,type OperationActor,type OperationInput,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {getDbPool} from '../../../db/pool.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {isInstanceAdminIn} from '../../routeUtils/access.js';
import {applyContentCreationContext,resolveContentCreationContext} from '../../access/creationContext.js';
import {assertProjectWriterForMutation} from '../../projects/access.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
import {keyedSecretFingerprint} from '../../systemCommands/operationSupport.js';
import type {OperationRegistration} from '../../systemActions/operations/types.js';
import {OperationError,OperationBusinessError,hidden,markedRefusal} from '../../systemActions/operations/errors.js';
import {SourceChannelCreateConflict,SourceChannelMutationError} from '../channels/sourceChannelService.js';
import {assertSourceConnectionManageable,assertSourceConnectionReadable} from '../sourceConnectionAccess.js';
import {SourceObjectRefusal} from '../sourceObjectErrors.js';
import {SourceRecipePipelineBridgeService} from '../sourceRecipes/pipelineBridgeService.js';
import {CustomSourceCreateFlowService} from './customSourceCreateFlowService.js';
import {CustomSourceRepairService} from './customSourceRepairService.js';
import {CustomSourceCredentialService} from './customSourceCredentialService.js';
import {PgCustomSourceHandlerRepository} from './customSourceHandlerRepository.js';

const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const CONNECTION_OPS=['source.custom.handler.generate','source.custom.handler.test.request','source.custom.handler.activate','source.custom.repair.request','source.custom.rollback','source.custom.pipeline_bridge'] as const;
type ConnectionOp=typeof CONNECTION_OPS[number];

/** A Custom Source the caller currently manages; its Project writer is pinned before the row lock. */
async function managedSource(db:Queryable,p:SpaceUserIdentity,id:string,lock:boolean){
  const row=(await db.query<{project_id:string|null}>(`SELECT project_id FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL${lock?' FOR UPDATE':''}`,[id,p.spaceId])).rows[0];
  if(!row)throw hidden();
  await assertSourceConnectionManageable(db,p,id);
  return row.project_id;
}
/** A rate-limited generation is a transient refusal: rolled back, never cached. */
const rateLimited=(error:unknown)=>{if(error instanceof HttpError&&error.statusCode===429)return new OperationError('operation_limit_exceeded',429,true,'sources');return error;};
const classify=(error:unknown)=>{
  if(error instanceof SourceChannelCreateConflict)return new OperationBusinessError('operation_conflict',409,'sources');
  if(error instanceof SourceObjectRefusal)return markedRefusal(error,'sources');
  if(error instanceof SourceChannelMutationError&&error.statusCode===422)return new OperationBusinessError('operation_invalid_input',422,'sources');
  return undefined;
};
const queue=async(db:Queryable,a:OperationActor,kind:'custom_test'|'custom_repair',request:Record<string,unknown>)=>{
  const job=await new PgJobQueueRepository(db).enqueue({job_type:SOURCE_RETRIEVAL_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,max_attempts:1,payload:{kind,user_id:a.on_behalf_of_user_id,request}});
  return {id:job.id,space_id:a.space_id,job_id:job.id,status:'pending' as const};
};

/**
 * Custom Source lifecycle as human-only core commands over the existing
 * create-flow, repair, credential and settings writers. Handler tests and
 * repairs run handlers against external endpoints, so the command admits and
 * writes a single-attempt Job intent; the worker repeats admission and the
 * existing short per-step transactions settle versions, repair status,
 * activation or the canonical approval proposal. Every connection command
 * requires current Source management (the retained pipeline-bridge handler
 * did not check it). Credentials accept the secret once: the request
 * fingerprint keys it by an HMAC and no receipt, audit or Job carries it.
 */
export function customSourceRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  const flow=(db:Queryable)=>new CustomSourceCreateFlowService(db,config);
  const connectionOp=(id:ConnectionOp):OperationRegistration=>({
    definition:definitions.get(id)!,
    successStatus:id==='source.custom.handler.generate'||id==='source.custom.pipeline_bridge'?201:id.endsWith('.request')?202:200,
    async resolve(db,raw,a){const c=(raw as {source_connection_id:string}).source_connection_id;await managedSource(db,person(a),c,false);return {authority:`source_connection:${c}`,targets:{source_connection_id:c},resourceType:'source_connection',resourceId:c};},
    async authorize(db,raw,a){const p=person(a),c=(raw as {source_connection_id:string}).source_connection_id,project=await managedSource(db,p,c,false);if(project)await assertProjectWriterForMutation(db,a.space_id,project,p.userId);if(await managedSource(db,p,c,true)!==project)throw new OperationError('operation_conflict',409);},
    async authorizeResult(db,raw,a){
      const out=raw as {id:string;space_id:string;job_id?:string;source_connection_id?:string};
      if(out.space_id!==a.space_id)throw hidden();
      if(out.job_id){if(!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND job_type=$3 AND user_id=$4',[out.job_id,a.space_id,SOURCE_RETRIEVAL_JOB,a.on_behalf_of_user_id])).rows.length)throw hidden();return;}
      await assertSourceConnectionReadable(db,person(a),id==='source.custom.handler.generate'?out.source_connection_id!:out.id);
    },
    async execute(db,raw,a){
      const p=person(a),{source_connection_id:c,...body}=raw as {source_connection_id:string}&Record<string,unknown>;
      try{
        switch(id){
          case 'source.custom.handler.generate':{const v=await flow(db).generateHandler(p,c,body);return {id:v.id,space_id:a.space_id,source_connection_id:c,status:v.status};}
          case 'source.custom.handler.test.request':await flow(db).admitTest(p,c,body);return queue(db,a,'custom_test',raw as Record<string,unknown>);
          case 'source.custom.repair.request':await new CustomSourceRepairService(db,config).admitRepair(p,c);return queue(db,a,'custom_repair',raw as Record<string,unknown>);
          case 'source.custom.handler.activate':{const out=await flow(db).activateHandler(p,c,body);return {id:c,space_id:a.space_id,status:out.status,handler_version_id:out.handler_version.id,proposal_id:out.proposal_id??null,deltas:out.deltas};}
          case 'source.custom.rollback':{const out=await new CustomSourceRepairService(db,config).rollbackHandler(p,c,body);return {id:c,space_id:a.space_id,status:out.status,handler_version_id:out.handler_version.id,proposal_id:null,deltas:[],previous_handler_version_id:out.previous_handler_version_id??null};}
          case 'source.custom.pipeline_bridge':{const out=await new SourceRecipePipelineBridgeService(db,config).bridgePipelineHandler(p,c,body);return {id:out.connection.id,space_id:a.space_id,source_channel_id:out.connection.source_channel_id,recipe_version_id:out.recipe_version.id,bridged_from_connection_id:out.bridged_from_connection_id,bridged_from_handler_version_id:out.bridged_from_handler_version_id};}
        }
      }catch(error){throw rateLimited(error);}
    },
    classifyError:classify,
  });
  return [
    {
      definition:definitions.get('source.custom.draft.create')!,userContentCreation:true,successStatus:201,
      async resolve(_db,raw){const project=(raw as {project_id?:string|null}).project_id??null;return {authority:project?`project:${project}`:'personal_content',targets:{project_id:project},resourceType:'source_connection',resourceId:project??'new'};},
      async authorize(db,raw,a){const project=(raw as {project_id?:string|null}).project_id??null;if(project)await assertProjectWriterForMutation(db,a.space_id,project,a.on_behalf_of_user_id!);},
      async authorizeResult(db,raw,a){const out=raw as {id:string;space_id:string};if(out.space_id!==a.space_id)throw hidden();await assertSourceConnectionReadable(db,person(a),out.id);},
      async execute(db,raw,a){
        const input=raw as OperationInput<'source.custom.draft.create'>;
        const context=await resolveContentCreationContext(db,{userId:a.on_behalf_of_user_id!,requestSpaceId:a.space_id,projectId:input.project_id??null});
        if(context.spaceId!==a.space_id)throw new OperationError('operation_conflict',409);
        const out=await flow(db).createDraft(person(a),applyContentCreationContext(input as Record<string,unknown>,context));
        return {id:out.id,space_id:a.space_id,source_channel_id:out.source_channel_id,status:out.status};
      },
      classifyError:classify,
    },
    ...CONNECTION_OPS.map(connectionOp),
    {
      definition:definitions.get('source.custom.credential.create')!,successStatus:201,
      fingerprintInput:input=>keyedSecretFingerprint(config,input,['secret']),
      async resolve(_db,_raw,a){return {authority:`custom_source_credentials:${a.space_id}`,targets:{},resourceType:'custom_source_credential',resourceId:null};},
      async authorize(){},
      async authorizeResult(db,raw,a){const out=raw as {id:string;space_id:string};if(out.space_id!==a.space_id)throw hidden();await new CustomSourceCredentialService(db,config).requireOwnCredential(person(a),out.id);},
      async execute(db,raw,a){return new CustomSourceCredentialService(db,config).create(person(a),raw as Record<string,unknown>);},
    },
    {
      definition:definitions.get('source.custom.settings.space.update')!,
      async resolve(_db,_raw,a){return {authority:`custom_source_settings:${a.space_id}`,targets:{},resourceType:'custom_source_settings',resourceId:a.space_id};},
      async authorize(){},
      async execute(db,raw,a){return new PgCustomSourceHandlerRepository(db,config).updateSpacePolicy(person(a),raw as OperationInput<'source.custom.settings.space.update'>);},
      classifyError:classify,
    },
    {
      definition:definitions.get('source.custom.settings.instance.update')!,
      async resolve(){return {authority:'custom_source_settings:instance',targets:{},resourceType:'custom_source_settings',resourceId:'instance'};},
      async authorize(db,_raw,a){if(!await isInstanceAdminIn(db,config,a.on_behalf_of_user_id!))throw hidden();},
      async authorizeResult(db,_raw,a){if(!await isInstanceAdminIn(db,config,a.on_behalf_of_user_id!))throw hidden();},
      async execute(db,raw,a){return new PgCustomSourceHandlerRepository(db,config).updateInstanceRunnerSettings(person(a),raw as OperationInput<'source.custom.settings.instance.update'>);},
    },
  ];
}

/** Worker execution of queued handler tests and repairs; results carry identity and status only. */
export async function runCustomSourceRequest(config:ServerConfig,identity:SpaceUserIdentity,kind:'custom_test'|'custom_repair',body:Record<string,unknown>):Promise<Record<string,unknown>>{
  const pool=getDbPool(config.databaseUrl!),connection=String(body.source_connection_id);
  if(kind==='custom_test'){
    const out=await new CustomSourceCreateFlowService(pool,config).testHandler(identity,connection,body);
    return {source_connection_id:connection,handler_version_id:String(body.handler_version_id),run_id:out.run.id,run_status:out.run.status};
  }
  const out=await new CustomSourceRepairService(pool,config).repairHandler(identity,connection,body) as {status:string;handler_version?:{id:string};proposal_id?:string|null};
  return {source_connection_id:connection,repair_status:out.status,handler_version_id:out.handler_version?.id??null,proposal_id:out.proposal_id??null};
}
