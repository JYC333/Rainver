import {ExtractionOutcomeSchema,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import {optionalString} from '../routeUtils/common.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationError,hidden} from '../systemActions/operations/errors.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {ImportedHistoryExtractionService} from './extraction.js';

const OPERATION='project.imported_sessions.extract';
/** One claimed batch; the payload names only the claim, never record content. */
export const IMPORTED_HISTORY_EXTRACTION_JOB='imported_history_extraction';
type Input={project_id:string};

/**
 * Admits a manual extraction: the claim (the durable read mark) and its Job
 * commit with the core receipt. The model call and the canonical Brief/memory
 * proposals happen in the worker, which releases the claim on failure.
 */
export function importedHistoryExtractionRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration{return {
 definition:definitions.get(OPERATION)!,successStatus:202,
 async resolve(_db,raw){const i=raw as Input;return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id},resourceType:'project',resourceId:i.project_id};},
 async authorize(db,raw,a){const i=raw as Input;
  await assertProjectWriter(db,a.space_id,i.project_id,a.on_behalf_of_user_id!,{allowArchived:true});
  try{await lockActiveProjectForMutation(db,a.space_id,i.project_id);}catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'projects');throw e;}
  await assertProjectWriterForMutation(db,a.space_id,i.project_id,a.on_behalf_of_user_id!);
 },
 async authorizeResult(db,raw,a){const out=raw as {space_id:string;project_id:string;job_id:string|null};if(out.space_id!==a.space_id)throw hidden();
  await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);
  if(out.job_id&&!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND job_type=$3 AND user_id=$4',[out.job_id,a.space_id,IMPORTED_HISTORY_EXTRACTION_JOB,a.on_behalf_of_user_id])).rows.length)throw hidden();
 },
 async execute(db,raw,a){const i=raw as Input,identity={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};
  const claimed=await new ImportedHistoryExtractionService(db,config).claim(identity,i.project_id);
  const job=claimed.records===0?null:await new PgJobQueueRepository(db).enqueue({job_type:IMPORTED_HISTORY_EXTRACTION_JOB,space_id:a.space_id,user_id:identity.userId,payload:{checkpoint_id:claimed.checkpointId,project_id:i.project_id},max_attempts:1});
  return {id:claimed.checkpointId,project_id:i.project_id,space_id:a.space_id,job_id:job?.id??null,records_claimed:claimed.records};
 },
};}

/** Performs one claimed manual batch with the requesting person's spend and current writer authority. */
export function registerImportedHistoryExtractionJob(registry:JobHandlerRegistry,config:ServerConfig):void{
 if(!config.databaseUrl)return;
 registry.register(IMPORTED_HISTORY_EXTRACTION_JOB,async job=>{
  const checkpointId=optionalString(job.payload.checkpoint_id),projectId=optionalString(job.payload.project_id);
  if(!checkpointId||!projectId||!job.user_id)throw new Error('imported_history_extraction requires its claim, Project and person');
  const outcome=await new ImportedHistoryExtractionService(getDbPool(config.databaseUrl!),config).processClaim({spaceId:job.space_id,userId:job.user_id},projectId,checkpointId,{kind:'person',user_id:job.user_id});
  return ExtractionOutcomeSchema.parse(outcome);
 });
}
