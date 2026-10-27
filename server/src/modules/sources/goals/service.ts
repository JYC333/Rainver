import {canWriteProject} from '../../projects/access.js';
import {assertSafeGoalMessage} from './messageSafety.js';
import {takeGoalSchedulingOwnership,setLegacyGoalPaused,legacyGoalView} from './compatibility.js';
import {GOAL_CURSOR_RESET_SQL} from './selection.js';
import {retainGoalSample,cleanGoalSamples} from './samples.js';
import {selectGoalResult} from './selection.js';
import {publicGoalContribution,publicGoalValidation} from './privacy.js';
import {randomUUID} from 'node:crypto';
import {SourceGoalCreateSchema,SourceGoalVersionWriteSchema,SourceGoalPlanSchema,SourceGoalStartSchema,type SourceGoalBindingSpec} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {resolveContentCreationContext} from '../../access/creationContext.js';
import {PgSchedulerTaskStore} from '../../scheduler/taskStore.js';
import {requireGoal,requireLegacyGoalSource,requireGoalSource,requireAuthorRun,goalSourceFingerprint,type GoalRow} from './access.js';
import {validateGoalSample} from './validation.js';
export interface GoalExecutionResult {selection?:{observed_count:number;filtered_count:number;selected_count:number;remaining_count:number};output:unknown;fixture:unknown;source_kind:string;cursor:Record<string,unknown>;cleanup:()=>Promise<void>;filesRoot:string;envelope:unknown;}
export interface GoalExecutionPort {execute(identity:SpaceUserIdentity,g:GoalRow,spec:SourceGoalBindingSpec,cursor:Record<string,unknown>,signal:AbortSignal,fixture?:unknown,inspectOnly?:boolean):Promise<GoalExecutionResult>;}
export class SourceGoalService {
 constructor(readonly db:Pool,readonly config:ServerConfig,readonly executor:GoalExecutionPort){}
 async create(identity:SpaceUserIdentity,raw:unknown){
  const input=SourceGoalCreateSchema.parse(raw);assertSafeGoalMessage(input.intent);
  const scope=await resolveContentCreationContext(this.db,{userId:identity.userId,requestSpaceId:identity.spaceId,projectId:input.project_id});
  const profile=await this.db.query(`SELECT 1 FROM agents a JOIN agent_runtime_profiles p ON p.agent_id=a.id AND p.space_id=a.space_id WHERE a.id=$1 AND a.space_id=$2 AND a.owner_user_id=$3 AND a.status='active' AND p.id=$4 AND p.enabled=true`,[input.agent_id,scope.spaceId,identity.userId,input.runtime_profile_id]);
  if(!profile.rows[0])throw new HttpError(403,'Owned enabled Agent/Profile required');
  const r=await this.db.query(`INSERT INTO source_goals(id,space_id,owner_user_id,project_id,agent_id,runtime_profile_id,intent_json,budget_json,creation_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(space_id,owner_user_id,creation_key) DO NOTHING RETURNING *`,[randomUUID(),scope.spaceId,identity.userId,scope.projectId,input.agent_id,input.runtime_profile_id,{intent:input.intent,includes:input.includes,excludes:input.excludes},input.budget,input.creation_key??null]);if(r.rows[0])return r.rows[0];const existing=(await this.db.query('SELECT * FROM source_goals WHERE space_id=$1 AND owner_user_id=$2 AND creation_key=$3',[scope.spaceId,identity.userId,input.creation_key])).rows[0];if(!existing || existing.intent_json.intent!==input.intent || existing.project_id!==scope.projectId)throw new HttpError(409,'Goal creation key changed');return existing;
 }
 async list(identity:SpaceUserIdentity){
  const ids=await this.db.query<{id:string}>(`SELECT g.id FROM source_goals g JOIN space_memberships m ON m.space_id=g.space_id AND m.user_id=$2 AND m.status='active' WHERE g.space_id=$1 AND g.status<>'deleted' AND (g.owner_user_id=$2 OR g.project_id IS NOT NULL) ORDER BY g.created_at DESC LIMIT 50`,[identity.spaceId,identity.userId]);
  const result=[];for(const row of ids.rows){try{const g=await requireGoal(this.db,identity,row.id);await requireLegacyGoalSource(this.db,this.config,identity,g);const versions=await this.db.query('SELECT plan_json FROM source_goal_versions WHERE goal_id=$1',[g.id]);for(const v of versions.rows)for(const spec of SourceGoalPlanSchema.parse(v.plan_json).sources)await requireGoalSource(this.db,this.config,identity,g,spec,false);result.push(g);}catch{}}
  return {goals:result};
 }
 async resume(identity:SpaceUserIdentity,id:string,versionId:string){
  return withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true);
   if(await setLegacyGoalPaused(db,identity,id,false,this.config)){await db.query(`UPDATE source_goals SET status='running' WHERE id=$1`,[id]);return {status:'running'};}
   if(g.active_version_id!==versionId)throw new HttpError(409,'Exact active plan required');
   if(g.status==='running')return {status:'running'};
   if(g.status!=='paused')throw new HttpError(409,'Goal is not paused');
   const bindings=await db.query<{spec_json:SourceGoalBindingSpec;fixture_json:{authority_sha256:string}}>('SELECT spec_json,fixture_json FROM source_goal_bindings WHERE goal_id=$1',[id]);
   for(const b of bindings.rows){const c=await requireGoalSource(db,this.config,identity,g,b.spec_json);if(goalSourceFingerprint(c)!==b.fixture_json.authority_sha256)throw new HttpError(409,'Source scope changed; new preview required');}
   await db.query(`UPDATE source_goals SET status='running',updated_at=now() WHERE id=$1`,[id]);
   await new PgSchedulerTaskStore(db).upsert({taskType:'source_goal_tick',taskKey:id,scopeType:'space',scopeId:g.space_id,spaceId:g.space_id,userId:g.owner_user_id,status:'active',nextRunAt:new Date().toISOString(),metadataJson:{version_id:versionId}});
   return {status:'running'};
  });
 }
 async read(identity:SpaceUserIdentity,id:string){
  const goal=await requireGoal(this.db,identity,id);await requireLegacyGoalSource(this.db,this.config,identity,goal);await cleanGoalSamples(this.db,this.config,id);
  const bindings=await this.db.query('SELECT * FROM source_goal_bindings WHERE space_id=$1 AND goal_id=$2',[identity.spaceId,id]);
  for(const b of bindings.rows)await requireGoalSource(this.db,this.config,identity,goal,b.spec_json,false);
  const versions=await this.db.query('SELECT * FROM source_goal_versions WHERE space_id=$1 AND goal_id=$2 ORDER BY revision DESC',[identity.spaceId,id]);
  for(const v of versions.rows)for(const spec of SourceGoalPlanSchema.parse(v.plan_json).sources)await requireGoalSource(this.db,this.config,identity,goal,spec,false);
  const previews=await this.db.query('SELECT id,version_id,status,result_json,expires_at,created_at FROM source_goal_previews WHERE space_id=$1 AND goal_id=$2 ORDER BY created_at DESC LIMIT 10',[identity.spaceId,id]);
  const runs=await this.db.query('SELECT * FROM source_goal_runs WHERE space_id=$1 AND goal_id=$2 ORDER BY started_at DESC LIMIT 50',[identity.spaceId,id]);
  const repairs=await this.db.query('SELECT r.* FROM source_goal_repairs r JOIN source_goal_bindings b ON b.id=r.binding_id AND b.space_id=r.space_id WHERE b.space_id=$1 AND b.goal_id=$2 ORDER BY r.created_at DESC LIMIT 20',[identity.spaceId,id]);
  const messages=goal.session_id?await new (await import('../../sessions/repository.js')).PgSessionRepository(this.db).listMessages(identity.spaceId,identity.userId,goal.session_id,200,0):[];
  const agentRuns=await this.db.query(`SELECT id,status,created_at FROM runs WHERE space_id=$1 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$2 ORDER BY created_at DESC LIMIT 10`,[identity.spaceId,id]);
  const schedule=await new PgSchedulerTaskStore(this.db).get('source_goal_tick',id);
  const legacy=await legacyGoalView(this.db,goal);
  const can_manage=goal.owner_user_id===identity.userId&&(!goal.project_id||await canWriteProject(this.db,goal.space_id,goal.project_id,identity.userId));
  return {goal,can_manage,messages,legacy,agent_runs:agentRuns.rows,schedule:goal.compatibility_json?.scheduler_owner==='legacy'?legacy?.schedule:schedule,repairs:repairs.rows.map(r=>({...r,validation_json:r.validation_json?{checks:r.validation_json.checks?.map(publicGoalValidation),scope_unchanged:r.validation_json.scope_unchanged,validated_at:r.validation_json.validated_at}:null})),versions:versions.rows,bindings:bindings.rows.map(b=>({...b,repair_block_reason:b.fixture_json?.repair_block_reason??null,fixture_json:b.fixture_json?{authority_sha256:b.fixture_json.authority_sha256,validation:publicGoalValidation(b.fixture_json.validation),failure:b.fixture_json.failure?{code:b.fixture_json.failure.code,responses:b.fixture_json.failure.responses}:null}:null})),previews:previews.rows.map(p=>({...p,result_json:{...p.result_json,contributions:p.result_json.contributions?.map(publicGoalContribution)}})),runs:runs.rows.map(r=>({...r,result_json:r.result_json?{...r.result_json,validation:publicGoalValidation(r.result_json.validation)}:null}))};
 }
 async writeVersion(identity:SpaceUserIdentity,raw:unknown,runId:string){
  const input=SourceGoalVersionWriteSchema.parse(raw);
  return withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[input.goal_id]);
   const g=await requireGoal(db,identity,input.goal_id,true);await requireAuthorRun(db,g,runId,'explore');
   if(g.revision!==input.expected_revision)throw new HttpError(409,'Goal revision changed or running');
   for(const spec of input.plan.sources)await requireGoalSource(db,this.config,identity,g,spec,true,g.status==='paused');
   const count=await db.query('SELECT count(*)::int AS n FROM source_goal_versions WHERE goal_id=$1 AND adjustment_cycle=$2',[g.id,g.adjustment_cycle??0]);if(count.rows[0].n>=g.budget_json.agent_attempts)throw new HttpError(429,'source_goal_exploration_budget_exhausted');
   const id=randomUUID();await db.query('INSERT INTO source_goal_versions(id,space_id,goal_id,revision,plan_json,created_by_run_id,adjustment_cycle) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,g.space_id,g.id,g.revision+1,{...input.plan,intent_snapshot:{intent:g.intent_json.intent,includes:input.plan.filters?.includes??g.intent_json.includes,excludes:input.plan.filters?.excludes??g.intent_json.excludes}},runId,g.adjustment_cycle??0]);
   await db.query(`UPDATE source_goals SET revision=revision+1,current_version_id=$2,status=CASE WHEN status='paused' OR active_version_id IS NOT NULL AND status='running' THEN status ELSE 'draft' END,updated_at=now() WHERE id=$1`,[g.id,id]);return {id,revision:g.revision+1};
  });
 }
 async preview(identity:SpaceUserIdentity,id:string,versionId:string,signal:AbortSignal){
  const reservation=await withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true);
   if(g.current_version_id!==versionId || ['paused'].includes(g.status))throw new HttpError(409,'Preview version/state changed');
   const versions=await db.query('SELECT plan_json FROM source_goal_versions WHERE id=$1 AND goal_id=$2 AND space_id=$3',[versionId,id,g.space_id]);if(!versions.rows[0])throw new HttpError(404,'Version not found');
   const count=await db.query('SELECT count(*)::int AS n FROM source_goal_previews WHERE version_id=$1',[versionId]);if(count.rows[0].n>=3)throw new HttpError(429,'Preview budget exhausted');
   const previewId=randomUUID();await db.query(`INSERT INTO source_goal_previews(id,space_id,goal_id,version_id,status,result_json,expires_at) VALUES($1,$2,$3,$4,'running','{}',now()+interval '15 minutes')`,[previewId,g.space_id,id,versionId]);
   return {g,previewId,plan:SourceGoalPlanSchema.parse(versions.rows[0].plan_json)};
  });
  const {previewId,plan}=reservation;const g={...reservation.g,intent_json:plan.intent_snapshot??reservation.g.intent_json,execution_filters:plan.filters,execution_scope:previewId};const contributions=[];
  for(const spec of plan.sources){
   try{
    const authority=goalSourceFingerprint(await requireGoalSource(this.db,this.config,identity,g,spec));
    const rawRun=await this.executor.execute(identity,g,spec,{},signal);
    let run;try{run=await selectGoalResult(this.db,g,spec,{},rawRun);}catch(e){await rawRun.cleanup();throw e;}
    try{const check=validateGoalSample(run.output,{budget:g.budget_json,...g.intent_json});
     contributions.push(await retainGoalSample(this.db,this.config,spec.source_connection_id,{source_connection_id:spec.source_connection_id,source_kind:run.source_kind,status:check.ok?'succeeded':'insufficient',authority_sha256:authority,validation:publicGoalValidation(check),selection:run.selection,output:check.output,capture_policy:(run.envelope as {capture_policy?:string}).capture_policy,retention_policy:(run.envelope as {retention_policy?:string}).retention_policy,fixture:run.fixture,implementation:spec.implementation}));
    }finally{await run.cleanup();}
   }catch(error){contributions.push({source_connection_id:spec.source_connection_id,status:'failed',error:error instanceof Error && /^source_[a-z_]+$/.test(error.message)?error.message:'source_execution_refused'});}
  }
  await requireGoal(this.db,identity,id,true);
  const ready=contributions.length===plan.sources.length && contributions.every(c=>c.status==='succeeded');
  const result={version_id:versionId,contributions,limitations:plan.limitations,complete:ready,observed_at:new Date().toISOString()};
  const stored=await this.db.query(`UPDATE source_goal_previews SET status=$2,result_json=$3 WHERE id=$1 AND EXISTS(SELECT 1 FROM source_goals WHERE id=source_goal_previews.goal_id AND status NOT IN ('paused','deleted')) RETURNING id`,[previewId,ready?'ready':'partial',result]);if(!stored.rows[0])throw new HttpError(409,'Goal stopped before preview storage');
  await this.db.query(`UPDATE source_goals SET status=$3,updated_at=now() WHERE id=$1 AND current_version_id=$2 AND status NOT IN ('paused','deleted','running')`,[id,versionId,ready?'preview_ready':'needs_information']);
  return {id:previewId,...result,contributions:contributions.map(publicGoalContribution)};
 }
 async start(identity:SpaceUserIdentity,id:string,raw:unknown){
  const input=SourceGoalStartSchema.parse(raw);
  return withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true);
   if(g.start_key===input.idempotency_key && g.active_version_id===input.version_id){return {goal_id:id,version_id:g.active_version_id,status:g.status};}
   if((g.status!=='preview_ready' && g.status!=='running') || g.current_version_id!==input.version_id || g.active_version_id===input.version_id)throw new HttpError(409,'Plan changed or already started');
   await cleanGoalSamples(db,this.config,id);
   const p=await db.query(`SELECT result_json FROM source_goal_previews WHERE id=$1 AND goal_id=$2 AND version_id=$3 AND status='ready' AND expires_at>now()`,[input.preview_id,id,input.version_id]);if(!p.rows[0])throw new HttpError(409,'Fresh exact-version preview required');
   const active=await db.query('SELECT lease_token FROM source_goal_bindings WHERE goal_id=$1 FOR UPDATE',[id]);if(active.rows.some(b=>b.lease_token))throw new HttpError(409,'Source execution in progress');
   const v=await db.query('SELECT plan_json FROM source_goal_versions WHERE id=$1',[input.version_id]);const plan=SourceGoalPlanSchema.parse(v.rows[0].plan_json);
   if(plan.interval_seconds && plan.interval_seconds<g.budget_json.interval_seconds)throw new HttpError(403,'Faster collection requires an approved usage limit');
   for(const spec of plan.sources){
    const c=await requireGoalSource(db,this.config,identity,g,spec);
    // Stop and transfer legacy triggers under the same source lock before
    // creating the single goal-owned schedule; mapping alone never transfers.
    await takeGoalSchedulingOwnership(db,id,g.space_id,spec.source_channel_id);
    const channel=await db.query('SELECT fetch_frequency FROM source_channels WHERE id=$1',[spec.source_channel_id]);if(channel.rows[0]?.fetch_frequency!=='manual')throw new HttpError(409,'Source already has a scheduling owner');
    const preview=p.rows[0].result_json.contributions.find((x:{source_connection_id:string})=>x.source_connection_id===c.id);
    if(!preview || preview.status!=='succeeded')throw new HttpError(409,'Preview contribution missing or insufficient');
    if(preview.authority_sha256!==goalSourceFingerprint(c))throw new HttpError(409,'Source authorization or scope changed since preview');
    await db.query(`INSERT INTO source_goal_bindings(id,space_id,goal_id,source_connection_id,spec_json,fixture_json) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(goal_id,source_connection_id) DO UPDATE SET spec_json=EXCLUDED.spec_json,fixture_json=jsonb_set(EXCLUDED.fixture_json,'{previous}',source_goal_bindings.fixture_json-'previous'),revision=source_goal_bindings.revision+1,status='active',previous_spec_json=source_goal_bindings.spec_json WHERE source_goal_bindings.lease_token IS NULL RETURNING id`,[randomUUID(),g.space_id,id,c.id,spec,preview]);
   }
   await db.query(`UPDATE source_goal_bindings SET ${GOAL_CURSOR_RESET_SQL} WHERE goal_id=$1`,[id]);
   await db.query(`UPDATE source_goal_bindings SET status='paused' WHERE goal_id=$1 AND NOT(source_connection_id=ANY($2::varchar[]))`,[id,plan.sources.map(s=>s.source_connection_id)]);
   await new PgSchedulerTaskStore(db).upsert({taskType:'source_goal_tick',taskKey:id,scopeType:'space',scopeId:g.space_id,spaceId:g.space_id,userId:g.owner_user_id,status:'active',nextRunAt:new Date().toISOString(),metadataJson:{version_id:input.version_id}});
   await db.query(`UPDATE source_goals SET active_version_id=$2,start_key=$3,budget_json=jsonb_set(budget_json,'{interval_seconds}',to_jsonb($4::int)),status='running',updated_at=now() WHERE id=$1`,[id,input.version_id,input.idempotency_key,plan.interval_seconds??g.budget_json.interval_seconds]);return {goal_id:id,version_id:input.version_id,status:'running'};
  });
 }
 async stop(identity:SpaceUserIdentity,id:string,deleted=false){
  const result=await withDbTransaction(this.db,async db=>{await requireGoal(db,identity,id,true);await setLegacyGoalPaused(db,identity,id,true,this.config);
   await db.query('UPDATE source_goals SET status=$2,updated_at=now() WHERE id=$1',[id,deleted?'deleted':'paused']);
   if(deleted)await cleanGoalSamples(db,this.config,id,true);
   await db.query(`UPDATE scheduler_tasks SET status=$2,next_run_at=NULL WHERE task_type='source_goal_tick' AND task_key=$1`,[id,deleted?'archived':'paused']);
   return {status:deleted?'deleted':'paused'};
  });
  const runs=await this.db.query<{id:string}>(`SELECT id FROM runs WHERE space_id=$1 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$2 AND status IN ('queued','running','waiting_for_review')`,[identity.spaceId,id]);
  if(runs.rows.length){const {buildRunOrchestration}=await import('../../runs/orchestrationFactory.js');const {orchestration}=buildRunOrchestration(this.config);for(const run of runs.rows)await orchestration.cancelRun({run_id:run.id,space_id:identity.spaceId,requested_by_user_id:identity.userId,reason:'Source goal stopped'});}
  return result;
 }
}
