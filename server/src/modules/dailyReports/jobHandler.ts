import {withRunTerminalOwner} from '../systemActions/operations/proposalTransitions.js';
import type {ServerConfig} from '../../config.js';
import {dbPool,withQueryableTransaction,HttpError,type Queryable} from '../routeUtils/common.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {JobEffectLeaseLost,lockCurrentJobClaim,withJobEffectAuthority} from '../jobs/effectAuthority.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {failBoundedProviderTaskRun} from '../runs/boundedProviderTaskRun.js';
import {PgRunRepository} from '../runs/repository.js';
import {canonicalRunOutput} from '../runs/orchestrationResults.js';
import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import type {ProviderTaskAttemptRefs} from '../providers/commands/types.js';
import {DailyCaptureReportService,type DailyReportResult} from './service.js';
import {authorizeDailyReport,reportFingerprint,type DailyReportSnapshot} from './authority.js';
import {DAILY_REPORT_JOB} from './runOperation.js';

export function registerDailyCaptureReportHandler(registry:JobHandlerRegistry,config:ServerConfig):void{
 if(!config.databaseUrl)return;
 registry.register(DAILY_REPORT_JOB,async job=>{
  const db=dbPool(config),stored=await new PgJobQueueRepository(db).getJob(job.job_id);
  if(!stored||stored.space_id!==job.space_id||stored.user_id!==job.user_id||stored.job_type!==DAILY_REPORT_JOB||stored.payload_json.version!==1)throw new JobEffectLeaseLost('Daily report intent is unavailable');
  const snapshot=stored.payload_json.snapshot as DailyReportSnapshot,runId=stored.payload_json.run_id;
  if(typeof runId!=='string'||!snapshot||snapshot.spaceId!==job.space_id||snapshot.userId!==job.user_id||reportFingerprint(snapshot)!==stored.payload_json.input_hash)throw new JobEffectLeaseLost();
  let attempt:ProviderTaskAttemptRefs|undefined;
  try {
  const gate=async(tx:Queryable)=>{
   await authorizeDailyReport(tx,snapshot,attempt?.provider_id,attempt?.model);
   // Keep authority closure first, then the canonical cancelJob order: Job
   // claim -> Run. The terminal owner admits requests, not these domain rows.
   await lockCurrentJobClaim(tx,job);
   const run=(await tx.query<{status:string;owner_user_id:string;execution_kind:string;provider_task_control_id:string|null;provider_task_delivery_id:string|null;provider_task_snapshot_id:string|null}>('SELECT status,owner_user_id,execution_kind,provider_task_control_id,provider_task_delivery_id,provider_task_snapshot_id FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE',[job.space_id,runId])).rows[0];
   const current=await new PgJobQueueRepository(tx).getJob(job.job_id);
   if(!current||current.payload_json.version!==1||reportFingerprint(current.payload_json.snapshot as DailyReportSnapshot)!==stored.payload_json.input_hash||current.payload_json.input_hash!==stored.payload_json.input_hash||current.payload_json.run_id!==runId||!run||run.owner_user_id!==job.user_id||run.execution_kind!=='provider_task'||!['queued','running'].includes(run.status))throw new JobEffectLeaseLost();
   if(attempt&&run.status==='running'&&(run.provider_task_control_id!==attempt.control_id||run.provider_task_delivery_id!==attempt.delivery_id||run.provider_task_snapshot_id!==attempt.invocation_snapshot_id))throw new JobEffectLeaseLost('Daily report attempt changed');
  };
  const audit=async(tx:Queryable)=>{
   const decision=await enforce({...config,auditTransaction:tx},await loadActionRegistry(config),{action:'daily_capture.run',force_record:true,actor_type:'user',actor_id:snapshot.userId,space_id:snapshot.spaceId,resource_space_id:snapshot.spaceId,resource_type:'space',resource_id:snapshot.spaceId});
   if(decision.status!=='allow'||!decision.policy_decision_record_id)throw new HttpError(403,'Daily report execution refused');
  };
  const settle=async(work:(tx:Queryable)=>Promise<DailyReportResult>)=>withRunTerminalOwner(db,async()=>[{space_id:job.space_id,id:runId}],async tx=>{
   await gate(tx);await audit(tx);const output=await work(tx);
   if(output.status!=='succeeded')await new PgRunRepository(tx).markRunTerminal({space_id:job.space_id,run_id:runId,status:'cancelled',output_json:canonicalRunOutput({success:true,outputText:output.summary_preview,outputJson:output}),completed_at:new Date().toISOString()});
   await authorizeDailyReport(tx,snapshot,attempt?.provider_id,attempt?.model);
   await lockCurrentJobClaim(tx,job);
   const result={...output,run_id:runId};
   if(!await new PgJobQueueRepository(tx).completeJob(job.job_id,result,job.worker_id))throw new JobEffectLeaseLost();
   return result;
  });
  // Admission cannot be replayed after an unknown external effect. Reclaim's
  // existing source_dispatch fence preserves this marker and refuses retry.
  await withQueryableTransaction(db,async tx=>{
   await gate(tx);await audit(tx);
   const started=await tx.query("UPDATE jobs SET result_json=COALESCE(result_json,'{}'::jsonb)||'{\"source_dispatch\":\"started\"}'::jsonb WHERE id=$1 AND result_json->>'source_dispatch' IS DISTINCT FROM 'started' RETURNING id",[job.job_id]);
   if(!started.rows.length)throw new JobEffectLeaseLost('Daily report outcome unknown; do not repeat');
  });
  const result=await withJobEffectAuthority(db,job,()=>new DailyCaptureReportService(db,config).generateForDate({spaceId:snapshot.spaceId,userId:snapshot.userId,setting:snapshot.setting,localDate:snapshot.localDate,triggerOrigin:snapshot.triggerOrigin,createExperienceProposalsOverride:snapshot.input.create_experience_proposals,createMemoryProposalsOverride:snapshot.input.create_memory_proposals},{runId,snapshot,settle,authorizeAttempt:async(tx,refs)=>{if(attempt)throw new JobEffectLeaseLost('Daily report has already attempted its provider call; outcome may be unknown');attempt=refs;await gate(tx);await audit(tx);}}),async()=>{
   if(!attempt)throw new JobEffectLeaseLost('Daily report attempt missing');
   await withQueryableTransaction(db,async tx=>{
    await gate(tx);await audit(tx);
    // The single-send intent linearizes under the same Source/claim locks.
    // The shared effect authority still performs the immediate claim fence.
    const send=await tx.query(`UPDATE jobs SET result_json=result_json||'{"daily_report_send_admitted":true,"effect_started":true}'::jsonb WHERE id=$1 AND space_id=$2 AND status='running' AND claimed_by=$3 AND attempts=$4 AND result_json->>'daily_report_send_admitted' IS DISTINCT FROM 'true' RETURNING id`,[job.job_id,job.space_id,job.worker_id,job.attempts]);
    if(!send.rows.length)throw new JobEffectLeaseLost('Daily report send outcome unknown; do not repeat');
   });
  });
  if(result.status==='failed')throw new Error(result.summary_preview);
  if(result.status==='skipped')return settle(async()=>result);
  return {...result};
  } catch(error) {
   // Failure can only end this still-current Job and Run, never publish output.
   await withRunTerminalOwner(db,async()=>[{space_id:job.space_id,id:runId}],async tx=>{
    await lockCurrentJobClaim(tx,job);
    const held=(await tx.query<{provider_task_snapshot_id:string|null}>('SELECT provider_task_snapshot_id FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE',[job.space_id,runId])).rows[0];
    if(attempt&&held?.provider_task_snapshot_id!==attempt.invocation_snapshot_id)throw new JobEffectLeaseLost('Daily report failure no longer owns its attempt');
    const current=await new PgJobQueueRepository(tx).getJob(job.job_id);
    if(current?.payload_json.run_id!==runId||current.payload_json.input_hash!==stored.payload_json.input_hash)throw new JobEffectLeaseLost();
    const decision=await enforce({...config,auditTransaction:tx},await loadActionRegistry(config),{action:'daily_capture.run',force_record:true,actor_type:'user',actor_id:snapshot.userId,space_id:snapshot.spaceId,resource_space_id:snapshot.spaceId,resource_type:'space',resource_id:snapshot.spaceId});
    if(!decision.policy_decision_record_id)throw new Error('Daily report failure audit unavailable');
    await failBoundedProviderTaskRun(tx,job.space_id,runId,{code:'daily_report_failed',message:error instanceof Error?error.message:String(error)});
    // Only this owned failure path can prove a started invocation never reached
    // the durable send admission. Historical/unknown starts remain fenced.
    await tx.query(`UPDATE jobs SET result_json=COALESCE(result_json,'{}'::jsonb)||'{"daily_report_retry_safe":true}'::jsonb WHERE id=$1 AND result_json->>'daily_report_send_admitted' IS DISTINCT FROM 'true' AND result_json->>'effect_started' IS DISTINCT FROM 'true'`,[job.job_id]);
    if(await new PgJobQueueRepository(tx).failJob(job.job_id,'Daily report failed; external work will not be repeated',job.worker_id)!=='failed')throw new JobEffectLeaseLost();
   });
   throw error;
  }
 });
}
