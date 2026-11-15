import {createHash} from 'node:crypto';
import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {dbPool,HttpError,withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {recordDetailRead} from '../contentAccess/audit.js';
import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {JobEffectLeaseLost,lockCurrentJobClaim} from '../jobs/effectAuthority.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {PgActivityRepository,summaryInputFromBody} from './repository.js';
export const ACTIVITY_SUMMARY_JOB='activity_summary';
type Input=OperationInput<'activity.summary.request'>;
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function admitted(db:Queryable,identity:{spaceId:string;userId:string},input:Input){
 const refs=[...(input.activity_ids??[]).map(object_id=>({object_type:'activity' as const,object_id})),...(input.evidence_ids??[]).map(object_id=>({object_type:'extracted_evidence' as const,object_id})),...(input.source_item_ids??[]).map(object_id=>({object_type:'source_item' as const,object_id}))];
 await lockSourceRetrievalRelease(db,identity.spaceId,identity.userId,refs);
 const prepared=await new PgActivityRepository(db).prepareSummary(identity,summaryInputFromBody(input));
 for(const ref of refs)await recordDetailRead(db,{spaceId:identity.spaceId,viewerUserId:identity.userId,resourceType:ref.object_type,resourceId:ref.object_id});
 return createHash('sha256').update(canonical(prepared)).digest('hex');
}
export function activitySummaryRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:defs.get('activity.summary.request')!,successStatus:202,
  async resolve(_db,raw,a){return {authority:`activity-summary:${a.space_id}:${a.on_behalf_of_user_id}`,targets:raw,resourceType:'space',resourceId:a.space_id};},
  async authorize(db,raw,a){await admitted(db,person(a),raw as Input);},
  async authorizeResult(db,raw,a){
   const out=raw as {job_id:string;user_id:string};
   const job=await new PgJobQueueRepository(db).getJob(out.job_id);
   if(out.user_id!==a.on_behalf_of_user_id||!job||job.space_id!==a.space_id||job.user_id!==out.user_id||job.job_type!==ACTIVITY_SUMMARY_JOB)throw hidden();
   if(await admitted(db,person(a),job.payload_json.input as Input)!==job.payload_json.input_hash)throw hidden();
  },
  async execute(db,raw,a){
   const input=raw as Input,hash=await admitted(db,person(a),input);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`activity-summary:${a.space_id}:${a.on_behalf_of_user_id}`]);
   const prior=(await db.query<{id:string;status:string;result_json:Record<string,unknown>|null}>("SELECT id,status,result_json FROM jobs WHERE space_id=$1 AND user_id=$2 AND job_type=$3 AND status IN ('pending','claimed','running','completed') AND payload_json->'input'=$4::jsonb AND payload_json->>'input_hash'=$5 ORDER BY id LIMIT 1",[a.space_id,a.on_behalf_of_user_id,ACTIVITY_SUMMARY_JOB,JSON.stringify(input),hash])).rows[0];
   const job=prior??await new PgJobQueueRepository(db).enqueue({job_type:ACTIVITY_SUMMARY_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,payload:{input,input_hash:hash},max_attempts:1});
   return {job_id:job.id,user_id:a.on_behalf_of_user_id!,status:job.status==='pending'?'queued':job.status,...(job.status==='completed'?{result:job.result_json}:{})};
  },
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'activity'):undefined,
 };
}
export function registerActivitySummaryJob(registry:JobHandlerRegistry,config:ServerConfig){
 registry.register(ACTIVITY_SUMMARY_JOB,async job=>withQueryableTransaction(dbPool(config),async tx=>{
  const stored=await new PgJobQueueRepository(tx).getJob(job.job_id);
  if(!job.user_id||!stored||stored.space_id!==job.space_id||stored.user_id!==job.user_id||stored.job_type!==ACTIVITY_SUMMARY_JOB)throw new JobEffectLeaseLost();
  const input=stored.payload_json.input as Input,identity={spaceId:job.space_id,userId:job.user_id};
  if(await admitted(tx,identity,input)!==stored.payload_json.input_hash)throw new HttpError(409,'Summary inputs changed');
  await lockCurrentJobClaim(tx,job);
  const policy=await enforce({...config,auditTransaction:tx},await loadActionRegistry(config),{action:'activity.summary.request',force_record:true,actor_type:'user',actor_id:job.user_id,space_id:job.space_id,resource_space_id:job.space_id,resource_type:'space',resource_id:job.space_id});
  if(policy.status!=='allow'||!policy.policy_decision_record_id)throw new HttpError(403,'Summary is unavailable');
  const result=await new PgActivityRepository(tx).createSummaryRun(identity,summaryInputFromBody(input));
  const output={artifact_id:result.artifact_id,proposal_ids:result.proposal_ids,run_id:result.run_id,status:result.status};
  if(!await new PgJobQueueRepository(tx).completeJob(job.job_id,output,job.worker_id))throw new JobEffectLeaseLost();
  return output;
 }));
}
