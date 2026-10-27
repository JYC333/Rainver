import {checkRepairCalibration,CALIBRATION_UNAVAILABLE} from './calibration.js';
import {sourceGoalError} from './dispatchError.js';
import {GOAL_CURSOR_RESET_SQL} from './selection.js';
import {retainGoalSample,cleanGoalSamples} from './samples.js';
import {publicGoalValidation} from './privacy.js';
import {enforce} from '../../policy/index.js';
import {loadActionRegistry} from '../../policy/actionRegistry.js';
import {randomUUID} from 'node:crypto';
import {CustomSourceHandlerOutputSchema,SourceGoalRepairSchema,type SourceGoalBindingSpec} from '@rainver/protocol';
import {HttpError,withDbTransaction,type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {PgCustomSourceHandlerRepository} from '../customSources/customSourceHandlerRepository.js';
import type {ServerConfig} from '../../../config.js';
import {activeGoalIntent,requireGoal,requireGoalSource,requireAuthorRun,goalSourceFingerprint,type GoalRow} from './access.js';
import {validateGoalSample} from './validation.js';
import type {GoalExecutionPort} from './service.js';
import {validateTransientRepair} from './transientRepairValidation.js';
import {repairImplementationHash} from './ephemeralRepair.js';
type RepairBase={spec_json:SourceGoalBindingSpec;revision:number;fixture_json:{fixture?:unknown;output?:unknown;authority_sha256:string;failure?:{fixture?:unknown}};repair_attempts:number};
export class SourceGoalRepairService {
 constructor(readonly db:Pool,readonly config:ServerConfig,readonly executor:GoalExecutionPort){}
 async candidate(identity:SpaceUserIdentity,goalId:string,raw:unknown,runId:string){
  const input=SourceGoalRepairSchema.parse(raw);const g=await activeGoalIntent(this.db,await requireGoal(this.db,identity,goalId,true));await requireAuthorRun(this.db,g,runId,'repair',input.binding_id);await cleanGoalSamples(this.db,this.config,goalId);
  if(!await checkRepairCalibration(this.db,this.config,identity,g,input.binding_id))throw sourceGoalError(409,CALIBRATION_UNAVAILABLE);
  const r=await this.db.query<RepairBase>('SELECT spec_json,revision,fixture_json,repair_attempts FROM source_goal_bindings WHERE id=$1 AND goal_id=$2',[input.binding_id,goalId]);const b=r.rows[0];
  if(!b || b.revision!==input.expected_revision)throw new HttpError(409,'Repair base changed');
  const authority=await requireGoalSource(this.db,this.config,identity,g,b.spec_json);if(goalSourceFingerprint(authority)!==b.fixture_json.authority_sha256)throw new HttpError(409,'Source scope changed; repair cannot expand authorization');
  const prior=await this.db.query('SELECT id FROM source_goal_repairs WHERE binding_id=$1 AND created_by_run_id=$2 AND base_revision=$3',[input.binding_id,runId,b.revision]);if(prior.rows[0])throw new HttpError(429,'This repair Run already submitted a candidate');
  const spec={...b.spec_json,implementation:input.implementation};const candidateId=randomUUID();
  const reservation=await this.db.query('INSERT INTO source_goal_repairs(id,space_id,binding_id,base_revision,candidate_json,created_by_run_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[candidateId,g.space_id,input.binding_id,b.revision,spec,runId]);if(!reservation.rows[0])throw new HttpError(429,'Repair validation already reserved');
  return this.validateCandidate(identity,g,b,spec,candidateId,runId,input.binding_id,0);
 }
 /** Retry only an already generated candidate; no new Agent Run or attempt. */
 async retryPending(identity:SpaceUserIdentity,goalId:string){
  const g=await activeGoalIntent(this.db,await requireGoal(this.db,identity,goalId,true));if(g.status!=='running')return;
  // Cooldown cannot cross the original UTC quota window or keep a repair alive
  // indefinitely. Expired deferred candidates pause without another model Run.
  await this.db.query(`UPDATE source_goal_bindings b SET status='paused',retry_at=NULL,fixture_json=COALESCE(fixture_json,'{}'::jsonb)||'{"repair_block_reason":"source_repair_validation_insufficient"}'::jsonb WHERE b.goal_id=$1 AND b.status='repairing' AND EXISTS(SELECT 1 FROM source_goal_repairs r WHERE r.binding_id=b.id AND r.base_revision=b.revision AND r.status IN ('pending','candidate') AND (r.validation_json->>'retry_expires_at')::timestamptz<=now())`,[goalId]);
  await this.db.query(`UPDATE source_goal_repairs r SET status='failed' WHERE r.status IN ('pending','candidate') AND (r.validation_json->>'retry_expires_at')::timestamptz<=now() AND EXISTS(SELECT 1 FROM source_goal_bindings b WHERE b.id=r.binding_id AND b.goal_id=$1)`,[goalId]);
  const rows=await this.db.query<{id:string;binding_id:string;created_by_run_id:string;candidate_json:SourceGoalBindingSpec;base_revision:number}>(`SELECT r.* FROM source_goal_repairs r JOIN source_goal_bindings b ON b.id=r.binding_id WHERE b.goal_id=$1 AND b.status='repairing' AND (r.status='pending' OR r.status='candidate' AND (r.validation_json->>'validation_lease_until')::timestamptz<=now()) AND b.revision=r.base_revision AND b.lease_token IS NULL AND b.retry_at<=now()`,[goalId]);
  for(const row of rows.rows){
   const claim=await this.db.query(`UPDATE source_goal_repairs SET status='candidate',validation_json=validation_json||jsonb_build_object('validation_lease_until',now()+interval '130 seconds') WHERE id=$1 AND (status='pending' OR status='candidate' AND (validation_json->>'validation_lease_until')::timestamptz<=now()) RETURNING id`,[row.id]);if(!claim.rows[0])continue;
   const base=(await this.db.query<RepairBase>('SELECT spec_json,revision,fixture_json,repair_attempts FROM source_goal_bindings WHERE id=$1 AND goal_id=$2',[row.binding_id,goalId])).rows[0];
   if(!base||base.revision!==row.base_revision)continue;
   await this.validateCandidate(identity,g,base,row.candidate_json,row.id,row.created_by_run_id,row.binding_id,1).catch(error=>{if(!(error instanceof HttpError)&&!(error instanceof Error&&/^source_[a-z_]+$/.test(error.message)))throw error;});
  }
 }
 private async validateCandidate(identity:SpaceUserIdentity,g:GoalRow,b:RepairBase,spec:SourceGoalBindingSpec,candidateId:string,runId:string,bindingId:string,retryCount:number){
  const goalId=g.id;const input={binding_id:bindingId};g={...g,execution_scope:runId,execution_repair_binding:bindingId};
  const checks=[];let liveSample:unknown;
  try{
   await requireAuthorRun(this.db,g,runId,'repair',bindingId);await cleanGoalSamples(this.db,this.config,goalId);if(!await checkRepairCalibration(this.db,this.config,identity,g,bindingId))throw sourceGoalError(409,CALIBRATION_UNAVAILABLE);
   const live=await requireGoalSource(this.db,this.config,identity,g,spec).catch(error=>{if(error instanceof HttpError&&[403,404,409].includes(error.statusCode))throw sourceGoalError(error.statusCode,'source_authority_revoked');throw error;});if(goalSourceFingerprint(live)!==b.fixture_json.authority_sha256)throw sourceGoalError(409,'source_authority_revoked');
   const fresh=(await this.db.query('SELECT fixture_json FROM source_goal_bindings WHERE id=$1 AND revision=$2',[bindingId,b.revision])).rows[0];if(!fresh)throw new HttpError(409,'Repair base changed');b.fixture_json=fresh.fixture_json??{};
   if(!b.fixture_json.fixture||!CustomSourceHandlerOutputSchema.safeParse(b.fixture_json.output).success){
    const validation=await validateTransientRepair(this.db,this.executor,identity,{...g,execution_scope:runId},spec,b.fixture_json.authority_sha256);
    checks.push(...validation.checks);liveSample=validation.live_sample;
   }else{
   // Saved source fixture is replayed offline; compare stable IDs before live spend.
   const baseline=validateGoalSample(b.fixture_json.output,{budget:g.budget_json,...g.intent_json});
   for(const fixture of [b.fixture_json.fixture,...(b.fixture_json.failure?.fixture?[b.fixture_json.failure.fixture]:[]),undefined]){
    if(!await checkRepairCalibration(this.db,this.config,identity,g,input.binding_id))throw sourceGoalError(409,CALIBRATION_UNAVAILABLE);
    const result=await this.executor.execute(identity,{...g,execution_scope:runId},spec,{},AbortSignal.timeout(120000),fixture);
    try{checks.push(publicGoalValidation(validateGoalSample(result.output,{budget:g.budget_json,...g.intent_json,...(fixture===b.fixture_json.fixture?{baselineIds:baseline.stable_ids}:{})})));if(!fixture)liveSample=await retainGoalSample(this.db,this.config,b.spec_json.source_connection_id,{...(result.envelope as object),authority_sha256:b.fixture_json.authority_sha256,fixture:result.fixture,output:result.output,validation:checks.at(-1),source_kind:result.source_kind});}finally{await result.cleanup();}
   }
   }
   await requireAuthorRun(this.db,g,runId,'repair',input.binding_id);
   const passed=checks.every(c=>c?.ok);
   await this.db.query(`UPDATE source_goal_repairs SET status=$2,validation_json=$3 WHERE id=$1 AND EXISTS(SELECT 1 FROM source_goal_bindings b JOIN source_goals g ON g.id=b.goal_id WHERE b.id=source_goal_repairs.binding_id AND g.status='running')`,[candidateId,passed?'validated':'failed',{checks,scope_unchanged:true,validated_at:new Date().toISOString(),live_sample:liveSample}]);
   if(!passed)throw new Error('source_repair_validation_failed');

  }catch(error){
   const temporary=error instanceof Error&&['source_quota_exhausted','source_network_failed','source_timeout','source_host_unavailable','source_isolation_unavailable'].includes(error.message);
   const retryAt=(error as {retryAt?:string}).retryAt??new Date(Date.now()+60000).toISOString();
   const expires=Math.min(Date.now()+900000,(Math.floor(Date.now()/86400000)+1)*86400000);
   if(temporary&&retryCount===0&&Date.parse(retryAt)<expires){
    await this.db.query(`UPDATE source_goal_repairs SET status='pending',validation_json=$2 WHERE id=$1`,[candidateId,{checks,error:(error as Error).message,retry_count:1,retry_at:retryAt,retry_expires_at:new Date(expires).toISOString()}]);
    await this.db.query(`UPDATE source_goal_bindings SET status='repairing',retry_at=$3 WHERE id=$1 AND revision=$2`,[bindingId,b.revision,retryAt]);return {repair_id:candidateId,status:'pending'};
   }
   await this.db.query(`UPDATE source_goal_repairs SET status='failed',validation_json=$2 WHERE id=$1 AND status<>'published'`,[candidateId,{checks,error:'source_repair_validation_failed'}]);await this.db.query(`UPDATE source_goal_bindings SET status=$3,retry_at=CASE WHEN $3::varchar='repair_required' THEN now()+interval '60 seconds' ELSE NULL END WHERE id=$1 AND revision=$2`,[input.binding_id,b.revision,temporary||error instanceof HttpError || b.repair_attempts>=g.budget_json.repair_attempts?'paused':'repair_required']);await this.db.query(`UPDATE source_goal_bindings SET fixture_json=COALESCE(fixture_json,'{}'::jsonb)||$3::jsonb WHERE id=$1 AND revision=$2 AND status='paused'`,[bindingId,b.revision,{repair_block_reason:error instanceof Error&&['source_authority_revoked','source_policy_refused'].includes(error.message)?'source_authority_revoked':'source_repair_validation_insufficient'}]);throw error;}
  // Publication rejection is not validation failure. Policy/lease conflicts
  // retain this candidate for a later explicitly authorized human publication.
  try{return await this.publish(identity,goalId,candidateId,true);}catch(error){if(!(error instanceof HttpError) || ![403,409].includes(error.statusCode))throw error;await this.db.query(`UPDATE source_goal_bindings SET status='paused',retry_at=NULL WHERE id=$1 AND revision=$2 AND status IN ('repairing','repair_required')`,[input.binding_id,b.revision]);return {repair_id:candidateId,status:'validated'};}
 }
 async publish(identity:SpaceUserIdentity,goalId:string,candidateId:string,automatic=true){
  return withDbTransaction(this.db,async db=>{
   const g=await requireGoal(db,identity,goalId,true);if(g.status!=='running')throw new HttpError(409,'Goal no longer running');
   const c=await db.query<{binding_id:string;base_revision:number;candidate_json:SourceGoalBindingSpec;created_by_run_id:string;status:string;validation_json:{live_sample:unknown}}>(`SELECT * FROM source_goal_repairs WHERE id=$1 AND space_id=$2 AND status='validated' FOR UPDATE`,[candidateId,g.space_id]);const candidate=c.rows[0];if(!candidate)throw new HttpError(409,'Validated repair required');
   if(automatic)await requireAuthorRun(db,g,candidate.created_by_run_id,'repair',candidate.binding_id);
   await cleanGoalSamples(db,this.config,goalId);
   const settings=await new PgCustomSourceHandlerRepository(db,this.config).getEffectiveSettings(identity);
   if(!settings.runner.runner_enabled)throw new HttpError(403,'Administrator disabled execution');
   if(automatic && !settings.space.same_envelope_repair_auto_apply)throw new HttpError(403,'Administrator policy disables automatic repair publication');
   if(!automatic){const gate=await enforce(this.config,await loadActionRegistry(),{action:'source.custom.activate',actor_type:'user',actor_id:identity.userId,space_id:identity.spaceId,resource_type:'source_connection',resource_id:candidate.candidate_json.source_connection_id,force_record:true});if(gate.status!=='allow')throw new HttpError(403,'Explicit Source activation policy approval required');}
   const retained=(await db.query('SELECT validation_json FROM source_goal_repairs WHERE id=$1',[candidateId])).rows[0]?.validation_json;
   if(!retained?.live_sample?.fixture){
    const proof=retained?.live_sample?.transient_validation;
    if(proof?.mode!=='ephemeral_v1'||proof.implementation_sha256!==repairImplementationHash(candidate.candidate_json.implementation)||proof.synthetic_checks!==2||proof.live_checks!==2||proof.active_version_id!==g.active_version_id||proof.authority_sha256!==retained.live_sample.authority_sha256||!(Date.parse(proof.expires_at)>Date.now()))throw new HttpError(409,'Fresh transient repair validation required');
   }
   candidate.validation_json=retained;
   const current=await requireGoalSource(db,this.config,identity,g,candidate.candidate_json);const binding=await db.query('SELECT fixture_json FROM source_goal_bindings WHERE id=$1 AND goal_id=$2 FOR UPDATE',[candidate.binding_id,goalId]);if(binding.rows[0]?.fixture_json?.authority_sha256!==goalSourceFingerprint(current)||retained?.live_sample?.authority_sha256!==goalSourceFingerprint(current))throw new HttpError(409,'Source scope changed during validation');
   const changed=await db.query(`UPDATE source_goal_bindings SET previous_spec_json=spec_json,spec_json=$3,${GOAL_CURSOR_RESET_SQL},revision=revision+1,status='active',failures=0,fixture_json=$5,updated_at=now() WHERE id=$1 AND goal_id=$4 AND revision=$2 AND lease_token IS NULL RETURNING revision`,[candidate.binding_id,candidate.base_revision,candidate.candidate_json,goalId,{...(candidate.validation_json.live_sample as object),previous:{...binding.rows[0].fixture_json,previous:undefined}}]);if(!changed.rows[0])throw new HttpError(409,'Stale repair or source execution in progress');
   await db.query(`UPDATE source_goal_repairs SET status='published' WHERE id=$1`,[candidateId]);return {repair_id:candidateId,status:'published',revision:changed.rows[0].revision};
  });
 }
 async rollback(identity:SpaceUserIdentity,goalId:string,bindingId:string,expectedRevision:number){
  return withDbTransaction(this.db,async db=>{
   const g=await requireGoal(db,identity,goalId,true);const b=await db.query<{previous_spec_json:SourceGoalBindingSpec}>(`SELECT previous_spec_json FROM source_goal_bindings WHERE id=$1 AND goal_id=$2 FOR UPDATE`,[bindingId,goalId]);if(!b.rows[0]?.previous_spec_json)throw new HttpError(409,'No previous implementation');await requireGoalSource(db,this.config,identity,g,b.rows[0].previous_spec_json);
   const r=await db.query(`UPDATE source_goal_bindings SET spec_json=previous_spec_json,previous_spec_json=spec_json,fixture_json=COALESCE(fixture_json->'previous',fixture_json),${GOAL_CURSOR_RESET_SQL},revision=revision+1,status='active',updated_at=now() WHERE id=$1 AND revision=$2 AND lease_token IS NULL RETURNING revision`,[bindingId,expectedRevision]);if(!r.rows[0])throw new HttpError(409,'Rollback revision/lease changed');return {status:'rolled_back',revision:r.rows[0].revision};
  });
 }
}
