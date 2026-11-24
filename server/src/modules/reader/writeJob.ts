import {READER_JOB_OPERATIONS,READER_OPERATION_SCHEMAS,READER_WRITE_JOB,ReaderWriteJobResultSchema,type ReaderWriteJobResult,type ReaderWriteRequestView} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {JobEnvelopeForHandler,JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {JobEffectLeaseLost} from '../jobs/effectAuthority.js';
import {executeSourceDispatch} from '../sources/sourceDispatchExecution.js';
import {HttpError,dbPool,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {assertDocumentReadable,prepareReaderFiles} from './repository.js';
import {ReaderPositionStore} from './positions.js';
import {replaceAnnotationRange} from './annotationRange.js';
import {discoverReaderTarget} from './operations.js';

type JobOperation=typeof READER_JOB_OPERATIONS[number];
const outcomeOf=(status:number):ReaderWriteJobResult['outcome']=>status===409?'conflict':status===400||status===422?'invalid':'unavailable';

/** Settlement holds this Job's current claim on its own row until commit, so
 * a cancel or reclaim either waits for the write or makes it refuse. */
async function holdClaim(tx:Queryable,job:JobEnvelopeForHandler):Promise<void>{
 const held=await tx.query(`SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND status='running' AND claimed_by=$3 AND attempts=$4 FOR UPDATE`,[job.job_id,job.space_id,job.worker_id,job.attempts]);
 if(!held.rows.length)throw new JobEffectLeaseLost('Reader write Job no longer owns execution');
}

/**
 * One attempt (existing Source dispatch start fence): read the file-backed body
 * outside any transaction under the Job's effect credential, seal it, then one
 * short settlement transaction re-pins the document closure, rechecks the
 * person's current access and the document version, and runs the canonical
 * writer against only the sealed bodies. A pointer that changed meanwhile is a
 * conflict, never a new file read inside the transaction. Unknown outcomes are
 * never repeated.
 */
export async function settleReaderWrite(config:ServerConfig,db:Queryable,job:JobEnvelopeForHandler):Promise<ReaderWriteJobResult>{
 const operation=String(job.payload.operation) as JobOperation,user=String(job.payload.user_id);
 if(user!==job.user_id||!READER_JOB_OPERATIONS.includes(operation))throw new Error('Invalid Reader write identity');
 const parsed=READER_OPERATION_SCHEMAS[operation].input.safeParse(job.payload.request);
 if(!parsed.success)throw new Error('Invalid Reader write request');
 const input=parsed.data as Record<string,any>,identity:SpaceUserIdentity={spaceId:job.space_id,userId:user};
 try{
  const target=await discoverReaderTarget(db,identity.spaceId,input);
  if(!target)throw new HttpError(404,'Document not found');
  const files=await prepareReaderFiles(db,config,identity,target.document_type,target.document_id);
  return await withQueryableTransaction(db,async tx=>{
   await holdClaim(tx,job);
   if(operation==='reader.position.write'){
    const {document_type:_t,document_id:_d,...body}=input;
    const written=await new ReaderPositionStore(tx,config).write(identity,target.document_type,target.document_id,body,files);
    return {outcome:written.reason ?? (written.accepted?'applied':'not_accepted'),annotation_id:null};
   }
   const {annotation_id,...body}=input;
   const updated=await replaceAnnotationRange(tx,config,identity,annotation_id,body,files);
   return {outcome:'applied',annotation_id:updated.id};
  });
 }catch(error){
  if(error instanceof HttpError&&[400,403,404,409,422].includes(error.statusCode))return {outcome:outcomeOf(error.statusCode),annotation_id:null};
  throw error;
 }
}

export function registerReaderWriteJob(registry:JobHandlerRegistry,config:ServerConfig):void{
 if(!config.databaseUrl)return;
 registry.register(READER_WRITE_JOB,async job=>{
  const db=dbPool(config);
  return executeSourceDispatch(db,job,async()=>({...await settleReaderWrite(config,db,job)}));
 });
}

/** Requester-only, identity/status release under the person's current document access. */
export async function readReaderWriteRequest(db:Queryable,identity:SpaceUserIdentity,jobId:string):Promise<ReaderWriteRequestView>{
 const job=(await db.query<{id:string;status:string;payload_json:{operation?:string;request?:Record<string,unknown>};result_json:unknown}>('SELECT id,status,payload_json,result_json FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',[jobId,identity.spaceId,identity.userId,READER_WRITE_JOB])).rows[0];
 if(!job)throw new HttpError(404,'Reader write request not found');
 const target=await discoverReaderTarget(db,identity.spaceId,job.payload_json.request??{}).catch(()=>null);
 if(!target)throw new HttpError(404,'Reader write request not found');
 await assertDocumentReadable(db,identity,target.document_type,target.document_id);
 const status:ReaderWriteRequestView['status']=job.status==='claimed'||job.status==='running'?'running':job.status==='pending'||job.status==='completed'||job.status==='cancelled'?job.status:'failed';
 const value=(job.result_json??{}) as Record<string,unknown>;
 const result=status==='completed'?ReaderWriteJobResultSchema.safeParse({outcome:value.outcome,annotation_id:value.annotation_id}):null;
 return {job_id:job.id,status,result:result?.success?result.data:null};
}
