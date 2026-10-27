import {checkRepairCalibration} from './calibration.js';
import {GOAL_CURSOR_RESET_SQL} from './selection.js';
import {retainGoalSample,cleanGoalSamples} from './samples.js';
import {selectGoalResult} from './selection.js';
import {publicGoalValidation} from './privacy.js';
import {SourceGoalRepairService} from './repair.js';
import {queueSourceGoalAgent} from './agent.js';
import {materializeGoalBatch} from './materialization.js';
import {recoverGoalGap} from './recovery.js';
import {randomUUID} from 'node:crypto';
import {type SourceGoalBindingSpec} from '@rainver/protocol';
import {HttpError,withDbTransaction,type Pool} from '../../routeUtils/common.js';
import type {ServerConfig} from '../../../config.js';
import {PgSchedulerTaskStore} from '../../scheduler/taskStore.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
import type {JobHandlerRegistry} from '../../jobs/handlerRegistry.js';
import {getDbPool} from '../../../db/pool.js';
import {SourceGoalExecutor} from './execution.js';
import {activeGoalIntent,requireGoal,requireGoalSource,goalSourceFingerprint,type GoalRow} from './access.js';
import {validateGoalSample} from './validation.js';
import type {GoalExecutionPort} from './service.js';
export interface GoalBindingRow {id:string;space_id:string;goal_id:string;spec_json:SourceGoalBindingSpec;fixture_json?:{authority_sha256?:string};previous_spec_json:SourceGoalBindingSpec|null;revision:number;cursor_json:Record<string,unknown>;gaps_json:unknown[];failures:number;lease_token:string|null;}
export async function enqueueDueSourceGoals(db:Pool){
 const tasks=await new PgSchedulerTaskStore(db).listDue('source_goal_tick',new Date().toISOString(),25);
 for(const task of tasks)await withDbTransaction(db,async tx=>{
  const g=await tx.query<GoalRow>(`SELECT * FROM source_goals WHERE id=$1 AND status='running' FOR UPDATE`,[task.task_key]);if(!g.rows[0])return;
  const current=await new PgSchedulerTaskStore(tx).get('source_goal_tick',task.task_key);
  if(!current?.next_run_at || new Date(String(current.next_run_at)).getTime()>Date.now())return;
  await new PgJobQueueRepository(tx).enqueue({job_type:'source_goal_tick',space_id:g.rows[0].space_id,user_id:g.rows[0].owner_user_id,payload:{goal_id:task.task_key},max_attempts:2});
  await new PgSchedulerTaskStore(tx).upsert({taskType:'source_goal_tick',taskKey:task.task_key,scopeType:'space',scopeId:g.rows[0].space_id,spaceId:g.rows[0].space_id,userId:g.rows[0].owner_user_id,nextRunAt:new Date(Date.now()+g.rows[0].budget_json.interval_seconds*1000).toISOString(),lastRunAt:new Date().toISOString(),metadataJson:current.metadata_json});
 });
}
export async function runSourceGoalTick(db:Pool,config:ServerConfig,goalId:string,spaceId:string,executor:GoalExecutionPort=new SourceGoalExecutor(db,config)){
 const gr=await db.query<GoalRow>('SELECT * FROM source_goals WHERE id=$1 AND space_id=$2',[goalId,spaceId]);let g=gr.rows[0];if(!g || g.status!=='running')return {status:'stopped'};
 g=await activeGoalIntent(db,g);
 const identity={spaceId:g.space_id,userId:g.owner_user_id};await requireGoal(db,identity,g.id,true);await cleanGoalSamples(db,config,g.id);
 await new SourceGoalRepairService(db,config,executor).retryPending(identity,g.id);
 // Reconcile terminal existing Agent Runs after worker/daemon restart. An Agent
 // finishing without publishing a validated candidate never means success.
 await db.query(`UPDATE source_goal_bindings b SET status=CASE WHEN repair_attempts<$2 THEN 'repair_required' ELSE 'paused' END,retry_at=now()+interval '60 seconds' WHERE b.goal_id=$1 AND b.status='repairing' AND EXISTS (SELECT 1 FROM runs r WHERE r.space_id=b.space_id AND r.contract_snapshot_json->'workflow_input_json'->'source_goal'->>'binding_id'=b.id AND r.contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='repair') AND NOT EXISTS (SELECT 1 FROM source_goal_repairs c WHERE c.binding_id=b.id AND c.base_revision=b.revision AND (c.status='pending' OR c.status='candidate' AND c.validation_json ? 'validation_lease_until')) AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.space_id=b.space_id AND r.status IN ('queued','running','waiting_for_review','waiting_for_dependency','cancelling') AND r.contract_snapshot_json->'workflow_input_json'->'source_goal'->>'binding_id'=b.id AND r.contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='repair')`,[goalId,g.budget_json.repair_attempts]);
 const rows=await db.query<GoalBindingRow>(`SELECT * FROM source_goal_bindings WHERE goal_id=$1 AND status IN ('active','cooldown') AND (retry_at IS NULL OR retry_at<=now()) ORDER BY last_success_at NULLS FIRST,id`,[goalId]);
 const results=[];
 for(const b of rows.rows){
  const token=randomUUID(),runId=randomUUID();
  const claim=await db.query(`UPDATE source_goal_bindings SET lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1 AND revision=$3 AND (lease_until IS NULL OR lease_until<now()) AND EXISTS(SELECT 1 FROM source_goals WHERE id=$4 AND status='running' AND active_version_id=$5) RETURNING id`,[b.id,token,b.revision,g.id,g.active_version_id]);if(!claim.rows[0])continue;
  await db.query(`UPDATE source_goal_runs SET status='interrupted',ended_at=now() WHERE binding_id=$1 AND status='running'`,[b.id]);
  await db.query(`INSERT INTO source_goal_runs(id,space_id,goal_id,binding_id,version_id,status) VALUES($1,$2,$3,$4,$5,'running')`,[runId,spaceId,goalId,b.id,g.active_version_id]);
  let committed=false;
  let phase:'authorization'|'execution'|'materialization'='authorization';
  try{
   // Each binding is independent; bounded work ends before its DB lease can expire.
   const live=await requireGoalSource(db,config,identity,g,b.spec_json);
   if(b.fixture_json?.authority_sha256 && b.fixture_json.authority_sha256!==goalSourceFingerprint(live))throw new Error('source_authority_revoked');
   phase='execution';const rawRun=await executor.execute(identity,{...g,execution_scope:runId,execution_authority:b.fixture_json?.authority_sha256},b.spec_json,{...b.cursor_json,__goal_history:false},AbortSignal.timeout(120000));
   let run;try{run=await selectGoalResult(db,g,b.spec_json,{...b.cursor_json,__goal_history:false},rawRun);}catch(e){await rawRun.cleanup();throw e;}
   try{
    const valid=validateGoalSample(run.output,{budget:g.budget_json,...g.intent_json,allowEmpty:true});if(!valid.ok)throw new Error('source_parser_validation_failed');
    phase='materialization';const materialized=await materializeGoalBatch(db,config,g,b,token,runId,{...run,output:valid.output});committed=true;
    await db.query(`UPDATE source_goal_runs SET status=$3,result_json=$2,ended_at=now() WHERE id=$1`,[runId,{validation:publicGoalValidation(valid),selection:run.selection,...materialized,cursor:materialized.cursor},valid.count?'succeeded':'insufficient']);
    try{await recoverGoalGap(db,config,g,{...b,cursor_json:materialized.cursor},token,runId,executor);}catch{results.push({binding_id:b.id,status:valid.count?'succeeded':'insufficient',history_error:'source_backfill_failed'});continue;}
    results.push({binding_id:b.id,status:'succeeded'});
   }finally{await run.cleanup();}
  }catch(error){
   if(committed){results.push({binding_id:b.id,status:'succeeded',history_error:'source_backfill_failed'});continue;}
   const code=error instanceof HttpError?[403,404,409].includes(error.statusCode)?'source_authority_revoked':error.statusCode===429?'source_quota_exhausted':'source_contract_refused':error instanceof Error && /^source_[a-z_]+$/.test(error.message)?error.message:phase==='execution'?'source_execution_failed':phase==='authorization'?'source_authority_revoked':'source_materialization_failed';
   const retryAt=(error as {retryAt?:string}).retryAt;
   const temporary=['source_quota_exhausted','source_network_failed','source_timeout','source_host_unavailable','source_isolation_unavailable'].includes(code);
   const repairable=code==='source_parser_validation_failed' || code==='source_parser_failed' || code==='source_execution_failed';
   const rolledBack=repairable && !!b.previous_spec_json;
   const diagnostic=(error as {sourceDiagnostic?:unknown}).sourceDiagnostic;if(repairable && diagnostic)await db.query(`UPDATE source_goal_bindings SET fixture_json=jsonb_set(COALESCE(fixture_json,'{}'::jsonb),'{failure}',$3::jsonb) WHERE id=$1 AND lease_token=$2 AND EXISTS(SELECT 1 FROM source_goals WHERE id=source_goal_bindings.goal_id AND status='running')`,[b.id,token,JSON.stringify(await retainGoalSample(db,config,b.spec_json.source_connection_id,diagnostic as Record<string,unknown>))]);
   if(rolledBack)await db.query(`UPDATE source_goal_bindings SET spec_json=previous_spec_json,previous_spec_json=NULL,${GOAL_CURSOR_RESET_SQL},fixture_json=COALESCE(fixture_json->'previous',fixture_json),revision=revision+1 WHERE id=$1 AND lease_token=$2 AND revision=$3`,[b.id,token,b.revision]);
   await db.query(`UPDATE source_goal_bindings SET failures=failures+1,status=$3,retry_at=$4,gaps_json=CASE WHEN (SELECT count(*) FROM jsonb_array_elements(gaps_json) x WHERE COALESCE(x->>'status','') NOT IN ('covered','unrecoverable'))<64 THEN gaps_json || $5::jsonb ELSE gaps_json END,updated_at=now() WHERE id=$1 AND lease_token=$2`,[b.id,token,b.gaps_json.filter(x=>!['covered','unrecoverable'].includes((x as {status?:string}).status??'')).length>=63?'paused':temporary||rolledBack?'cooldown':repairable?'repair_required':'paused',retryAt??new Date(Date.now()+60000).toISOString(),JSON.stringify([{from:rolledBack?{watermark:b.cursor_json.watermark??null}:b.cursor_json,at:new Date().toISOString(),reason:code,recoverable:b.spec_json.supports_history}])]);
   await db.query(`UPDATE source_goal_runs SET status='failed',result_json=$2,ended_at=now() WHERE id=$1`,[runId,{error:code,retry_at:retryAt??null,rolled_back:rolledBack}]);results.push({binding_id:b.id,status:'failed',error:code});
  }finally{await db.query('UPDATE source_goal_bindings SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2',[b.id,token]);}
 }
 await checkRepairCalibration(db,config,identity,g,undefined,true);
 const repairs=await db.query<{id:string}>(`SELECT id FROM source_goal_bindings WHERE goal_id=$1 AND status='repair_required' AND repair_attempts<$2 AND lease_token IS NULL AND (retry_at IS NULL OR retry_at<=now())`,[goalId,g.budget_json.repair_attempts]);
 for(const repair of repairs.rows)await queueSourceGoalAgent(db,config,identity,g.id,'repair',repair.id).catch(async()=>{await db.query(`UPDATE source_goal_bindings SET status='paused' WHERE id=$1 AND status='repair_required'`,[repair.id]);});
 await db.query(`UPDATE source_goal_bindings SET status='paused' WHERE goal_id=$1 AND status='repair_required' AND repair_attempts>=$2`,[goalId,g.budget_json.repair_attempts]);
 return {results};
}
export function registerSourceGoalJob(registry:JobHandlerRegistry,config:ServerConfig){
 registry.register('source_goal_tick',async job=>runSourceGoalTick(getDbPool(config.databaseUrl!),config,String(job.payload.goal_id),job.space_id));
}
