import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {dbPool,HttpError,withQueryableTransaction} from '../routeUtils/common.js';
import type {ServerConfig} from '../../config.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {JobEffectLeaseLost,lockCurrentJobClaim} from '../jobs/effectAuthority.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {PgInformationDigestRepository} from './repository.js';
import {InformationDigestService} from './service.js';
import {lockDigestBackfill,type BackfillTarget} from './backfillAuthority.js';

export const DIGEST_BACKFILL_JOB='information_digest_backfill';
type Input=OperationInput<'digest.personal.backfill'>|OperationInput<'digest.project.backfill'>;
const identity=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
export function digestBackfillRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (['digest.personal.backfill','digest.project.backfill'] as const).map(id=>({
  definition:defs.get(id)!,successStatus:202,
  async resolve(_db,raw,a){const i=raw as Input;return {authority:`digest:${a.space_id}:${'project_id' in i?i.project_id:a.on_behalf_of_user_id}`,targets:i,resourceType:'space',resourceId:a.space_id};},
  async authorize(db,raw,a){if(!a.on_behalf_of_user_id)throw hidden();await lockDigestBackfill(db,identity(a),raw as Input);},
  async authorizeResult(db,raw,a){
   const out=raw as Input&{job_id:string;user_id:string};
   if(out.user_id!==a.on_behalf_of_user_id)throw hidden();
   const job=await new PgJobQueueRepository(db).getJob(out.job_id);
   if(!job||job.space_id!==a.space_id||job.user_id!==a.on_behalf_of_user_id||job.job_type!==DIGEST_BACKFILL_JOB)throw hidden();
   const target=job.payload_json.target as BackfillTarget;
   const state=await lockDigestBackfill(db,identity(a),target);
   if(state.hash!==job.payload_json.input_hash)throw hidden();
  },
  async execute(db,raw,a){
   const input=raw as Input,state=await lockDigestBackfill(db,identity(a),input);
   const project='project_id' in input?input.project_id:undefined;
   await new PgInformationDigestRepository(db).lockScope(a.space_id,project?'project':'personal',project??a.on_behalf_of_user_id!,input.date);
   const prior=(await db.query<{id:string;status:string;result_json:Record<string,unknown>|null}>(`SELECT id,status,result_json FROM jobs WHERE space_id=$1 AND user_id=$2 AND job_type=$3 AND status IN ('pending','claimed','running','completed') AND payload_json->'target'=$4::jsonb AND payload_json->>'input_hash'=$5 ORDER BY created_at,id LIMIT 1`,[a.space_id,a.on_behalf_of_user_id,DIGEST_BACKFILL_JOB,JSON.stringify(input),state.hash])).rows[0];
   const job=prior??await new PgJobQueueRepository(db).enqueue({job_type:DIGEST_BACKFILL_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,payload:{target:input,input_hash:state.hash},max_attempts:1});
   await state.recheck();
   return {...input,user_id:a.on_behalf_of_user_id!,job_id:job.id,status:job.status==='pending'?'queued':job.status,...(job.status==='completed'?{result:job.result_json}: {})};
  },
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'information_digest'):undefined,
 }));
}
/** Reuses the canonical queue's claim and the digest service's transaction.
 * This deterministic database job performs no provider I/O and never retries
 * an unknown effect. Both settlement and snapshot commit under the same claim. */
export function registerDigestBackfillJobs(registry:JobHandlerRegistry,config:ServerConfig){
 registry.register(DIGEST_BACKFILL_JOB,async job=>withQueryableTransaction(dbPool(config),async tx=>{
  if(!job.user_id)throw new JobEffectLeaseLost();
  const stored=await new PgJobQueueRepository(tx).getJob(job.job_id);
  if(!stored||stored.space_id!==job.space_id||stored.user_id!==job.user_id||stored.job_type!==DIGEST_BACKFILL_JOB)throw new JobEffectLeaseLost();
  const target=stored.payload_json.target as BackfillTarget;
  const state=await lockDigestBackfill(tx,{spaceId:job.space_id,userId:job.user_id},target);
  if(state.hash!==stored.payload_json.input_hash)throw new HttpError(409,'Digest inputs changed',{code:'digest_inputs_changed'});
  await lockCurrentJobClaim(tx,job);
  const policy=await enforce({...config,auditTransaction:tx},await loadActionRegistry(config),{action:target.project_id?'digest.project.backfill':'digest.personal.backfill',force_record:true,actor_type:'user',actor_id:job.user_id,space_id:job.space_id,resource_space_id:job.space_id,resource_type:'space',resource_id:job.space_id});
  if(policy.status!=='allow'||!policy.policy_decision_record_id)throw new HttpError(403,'Digest backfill is unavailable');
  const service=new InformationDigestService(tx);
  const result=target.project_id?await service.backfillProject(job.space_id,target.project_id,job.user_id,target.date):await service.backfillPersonal(job.space_id,job.user_id,target.date);
  await state.recheck();
  const output={digest_id:result.digest.id,created:result.created};
  if(!await new PgJobQueueRepository(tx).completeJob(job.job_id,output,job.worker_id))throw new JobEffectLeaseLost();
  return output;
 }));
}
