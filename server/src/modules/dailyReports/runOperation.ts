import type {RegisteredSystemActionDefinition} from '@rainver/protocol';
import {canonical} from '../systemActions/operations/repository.js';
import type {Queryable} from '../routeUtils/common.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {PgRunRepository} from '../runs/repository.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {DailyReportRefusal,prepareDailyReport,authorizeDailyReport,reportFingerprint,type DailyReportInput,type DailyReportSnapshot} from './authority.js';
export const DAILY_REPORT_JOB='daily_capture_report';
/** Caller owns admission, audit and commit. Both manual and scheduled entry use it. */
export async function requestDailyReport(db:Queryable,space:string,user:string,input:DailyReportInput,origin:'manual'|'automation'='manual',prepared?:DailyReportSnapshot){
 const snapshot=prepared??await prepareDailyReport(db,space,user,input,origin);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`daily-report-request:${space}:${user}:${snapshot.localDate}`]);
 const prior=(await db.query<{id:string;status:string;result_json:Record<string,unknown>;payload_json:{version?:number;run_id:string;snapshot:DailyReportSnapshot}}>("SELECT id,status,result_json,payload_json FROM jobs WHERE space_id=$1 AND user_id=$2 AND job_type=$3 AND payload_json->'snapshot'->>'localDate'=$4 ORDER BY created_at DESC,id DESC LIMIT 1",[space,user,DAILY_REPORT_JOB,snapshot.localDate])).rows[0];
 if(prior){
  if(prior.payload_json.version!==1||prior.payload_json.snapshot?.version!==1)throw new DailyReportRefusal(409,'Daily report intent version is unavailable; do not resend');
  const active=['pending','claimed','running'].includes(prior.status);
  const sameInput=canonical({...prior.payload_json.snapshot.input,local_date:snapshot.localDate})===canonical({...input,local_date:snapshot.localDate});
  if(active){
   if(!sameInput||reportFingerprint(prior.payload_json.snapshot)!==reportFingerprint(snapshot))throw new DailyReportRefusal(409,'Daily report intent changed; wait for the active report');
   return {job_id:prior.id,run_id:prior.payload_json.run_id,user_id:user,status:prior.status==='running'?'running' as const:'queued' as const};
  }
  if(prior.status==='completed'){
   if(!sameInput)throw new DailyReportRefusal(409,'Daily report already completed with different flags');
   await authorizeDailyReport(db,prior.payload_json.snapshot);
   return {job_id:prior.id,run_id:prior.payload_json.run_id,user_id:user,status:'completed' as const,result:prior.result_json};
  }
  const effect=prior.result_json??{};
  const safe=['failed','cancelled'].includes(prior.status)&&effect.daily_report_send_admitted!==true&&effect.effect_started!==true&&(effect.source_dispatch!=='started'||effect.daily_report_retry_safe===true);
  if(!safe)throw new DailyReportRefusal(409,'Daily report outcome is unknown; automatic resend is unsafe',{code:'daily_report_outcome_unknown',status:prior.status});
 }
 const run=await new PgRunRepository(db).createQueuedProviderTaskRun({space_id:space,user_id:user,task:'daily_report',trigger_origin:origin,run_type:'reflection',visibility:'private',prompt:`Generate Daily Capture Report for ${snapshot.localDate}`,contract_snapshot:{source:{kind:'direct',id:snapshot.setting.id},route_hints_json:{owner_domain:'dailyReports',report_date:snapshot.localDate,setting_id:snapshot.setting.id}}});
 const job=await new PgJobQueueRepository(db).enqueue({job_type:DAILY_REPORT_JOB,space_id:space,user_id:user,max_attempts:1,payload:{version:1,run_id:run.id,snapshot,input_hash:reportFingerprint(snapshot)}});
 return {job_id:job.id,run_id:run.id,user_id:user,status:'queued' as const};
}
export function dailyReportRunRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 const admitted=new WeakMap<Queryable,DailyReportSnapshot>();
 return {definition:defs.get('daily_capture.run')!,successStatus:202,
  async resolve(_db,raw,a){return {authority:`daily-report:${a.space_id}:${a.on_behalf_of_user_id}`,targets:raw,resourceType:'space',resourceId:a.space_id};},
  async authorize(db,raw,a){if(!a.on_behalf_of_user_id)throw hidden();admitted.set(db,await prepareDailyReport(db,a.space_id,a.on_behalf_of_user_id,raw as DailyReportInput));},
  async execute(db,raw,a){return requestDailyReport(db,a.space_id,a.on_behalf_of_user_id!,raw as DailyReportInput,'manual',admitted.get(db));},
  async authorizeResult(db,raw,a){const out=raw as {job_id:string;run_id:string;user_id:string};const job=await new PgJobQueueRepository(db).getJob(out.job_id);if(!job||job.space_id!==a.space_id||job.user_id!==a.on_behalf_of_user_id||out.user_id!==job.user_id||job.job_type!==DAILY_REPORT_JOB||job.payload_json.run_id!==out.run_id)throw hidden();await authorizeDailyReport(db,job.payload_json.snapshot as DailyReportSnapshot);},
  classifyError:e=>e instanceof DailyReportRefusal?markedRefusal(e,'dailyReports'):undefined,
 };
}
