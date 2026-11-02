import {queueProjectComposition} from '../composition/service.js';
import {assertGoalAnalysisManagement,nativeProfileFingerprint} from '../../sources/index.js';
import type {ThemeGoal} from './types.js';
import {ProjectThemeAnalysisConsentSchema,PROJECT_THEME_LIMITS} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {InformationBriefingService,selectExecution} from '../briefing/service.js';
import {PgBriefingRepository} from '../briefing/repository.js';
import {projectBriefing} from '../briefing/projection.js';
import {topicScope,TOPIC_METHOD} from './scope.js';
import type {ThemeRound} from './rounds.js';
import {canReadProject,canWriteProject} from '../../projects/access.js';
import {freezeReadingMethod} from '../../prompts/index.js';
const liveGoal=async(db:Queryable,identity:SpaceUserIdentity,id:string)=>{
 const g=(await db.query<ThemeGoal>('SELECT * FROM source_goals WHERE space_id=$1 AND id=$2 AND project_id IS NOT NULL AND status<>\'deleted\'',[identity.spaceId,id])).rows[0];
 if(!g||!await canReadProject(db,identity.spaceId,g.project_id!,identity.userId))throw new HttpError(404,'Project Following not found');return g as ThemeGoal & {project_id:string};
};
export async function configureThemeAnalysis(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,id:string,raw:unknown){
 const input=ProjectThemeAnalysisConsentSchema.parse(raw);
 return withQueryableTransaction(db,async tx=>{
  await tx.query('SELECT id FROM source_goals WHERE id=$1 AND space_id=$2 FOR UPDATE',[id,identity.spaceId]);
  await assertGoalAnalysisManagement(tx,config,identity,id);
  const g=await liveGoal(tx,identity,id);
  if(g.owner_user_id!==identity.userId||!await canWriteProject(tx,identity.spaceId,g.project_id,identity.userId))throw new HttpError(403,'Following owner and Project writer required');
  if(g.active_version_id!==input.expected_version_id)throw new HttpError(409,'Confirm the exact current purpose version');
  if(input.enabled&&(g.status!=='running'||g.compatibility_json?.scheduler_owner==='legacy'))throw new HttpError(409,'Confirm the canonical Following plan before enabling analysis');
  const execution=input.enabled?await selectExecution(tx,g.space_id,identity.userId,input):{};
  if(input.enabled){const method=await freezeReadingMethod(tx,{...identity,projectId:g.project_id},{goal_id:id,version_id:input.expected_version_id},TOPIC_METHOD);if(!method.frozen.content_hash||method.text.length>4000)throw new HttpError(409,'Theme method must be initialized and at most 4000 characters');}
  const consent={enabled:input.enabled,version_id:input.expected_version_id,...execution,confirmed_by:identity.userId,confirmed_at:new Date().toISOString(),limits:PROJECT_THEME_LIMITS};
  await tx.query(`UPDATE source_goals SET compatibility_json=jsonb_set(COALESCE(compatibility_json,'{}'::jsonb),'{theme_analysis}',$3::jsonb),updated_at=now() WHERE space_id=$1 AND id=$2`,[g.space_id,id,consent]);
  if(input.enabled)await tx.query("UPDATE source_goals SET compatibility_json=jsonb_set(compatibility_json,'{reading_composition_enabled}','true') WHERE id=$1",[id]);
  await queueProjectComposition(tx,g.space_id,g.project_id);
  return {analysis:consent,notice:'Explicit theme-analysis consent; collection authority, Source permissions and existing budgets are not expanded. No token/currency hard cap.'};
 });
}
export async function settleThemeRound(db:Queryable,config:ServerConfig,id:string,explicitRetry=false){
 await withQueryableTransaction(db,async tx=>{
  const round=(await tx.query<ThemeRound>('SELECT * FROM project_reading_rounds WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!round||['complete','superseded'].includes(round.status)||round.status==='blocked'&&round.error_code!=='theme_scope_busy'&&!explicitRetry)return;
  const g=(await tx.query<ThemeGoal>('SELECT * FROM source_goals WHERE space_id=$1 AND id=$2',[round.space_id,round.goal_id])).rows[0];
  if(!g||g.status!=='running'||g.active_version_id!==round.version_id||g.compatibility_json?.theme_analysis?.enabled!==true||g.compatibility_json?.theme_analysis?.version_id!==round.version_id){await tx.query("UPDATE project_reading_rounds SET status='superseded',error_code='theme_scope_changed',updated_at=now() WHERE id=$1",[id]);return;}
  // A delayed barrier cannot move an older round past an admitted newer
  // theme. Its unresolved inputs stay eligible in the scope's next round.
  const newer=await tx.query(`SELECT 1 FROM project_reading_rounds later JOIN information_briefings b ON b.id=later.briefing_id AND b.space_id=later.space_id WHERE later.space_id=$1 AND later.goal_id=$2 AND later.sequence>$3 AND b.status IN ('queued','ready') LIMIT 1`,[round.space_id,round.goal_id,round.sequence]);
  if(newer.rows.length){await tx.query("UPDATE project_reading_rounds SET status='superseded',error_code='theme_round_superseded',updated_at=now() WHERE id=$1",[id]);return;}
  const bindings=(await tx.query<{id:string;revision:number}>('SELECT id,revision FROM source_goal_bindings WHERE space_id=$1 AND goal_id=$2',[round.space_id,round.goal_id])).rows;
  if(round.targets_json.some(t=>!bindings.some(b=>b.id===t.binding_id&&b.revision===t.revision))){await tx.query("UPDATE project_reading_rounds SET status='superseded',error_code='theme_binding_changed' WHERE id=$1",[id]);return;}
  const terminal=new Set(['succeeded','insufficient','failed','cancelled','interrupted']);
  const audits=(await tx.query<{id:string;status:string;result_json:Record<string,unknown>}>('SELECT id,status,result_json FROM source_goal_runs WHERE space_id=$1 AND id=ANY($2::varchar[])',[round.space_id,round.targets_json.map(t=>t.audit_id)])).rows;
  const pending=round.targets_json.filter(t=>!audits.some(a=>a.id===t.audit_id&&terminal.has(a.status))).length;
  if(pending&&Date.parse(String(round.deadline_at))>Date.now())return;
  const materialPending=(await tx.query<{n:number}>(`SELECT count(DISTINCT e.source_item_id)::integer AS n FROM extraction_jobs e JOIN source_goal_items gi ON gi.source_item_id=e.source_item_id AND gi.space_id=e.space_id WHERE gi.space_id=$1 AND gi.goal_id=$2 AND e.status IN ('pending','running') AND e.job_type IN ('extract_text','snapshot') AND NOT COALESCE(e.metadata_json ? 'deep_project',false)`,[round.space_id,round.goal_id])).rows[0]?.n??0;
  if(materialPending&&Date.parse(String(round.deadline_at))>Date.now())return;
  const failed=audits.filter(a=>['failed','cancelled','interrupted'].includes(a.status)).length;
  const failureReasons:Record<string,number>={};for(const a of audits.filter(a=>['failed','cancelled','interrupted'].includes(a.status))){const raw=a.result_json?.error;const code=typeof raw==='string'&&/^source_[a-z_]{1,56}$/.test(raw)?raw:'source_collection_failed';failureReasons[code]=(failureReasons[code]??0)+1;}
  const coverage={failure_reasons:failureReasons,target_sources:round.targets_json.length,completed_sources:audits.filter(a=>terminal.has(a.status)).length,failed_sources:failed,pending_sources:pending,pending_originals:materialPending,complete:pending===0&&failed===0&&materialPending===0};
  await tx.query('UPDATE project_reading_rounds SET coverage_json=$2,updated_at=now() WHERE id=$1',[id,coverage]);
  if(failed===round.targets_json.length&&failed>0){await tx.query("UPDATE project_reading_rounds SET status='blocked',error_code=$2 WHERE id=$1",[id,Object.keys(failureReasons).length===1?Object.keys(failureReasons)[0]:'theme_collection_failed']);return;}
  // The first material boundary is immutable even if admission later fails.
  const cutoff=round.execution_json.input_cutoff??new Date(Math.min(Date.now(),Date.parse(String(round.deadline_at)))).toISOString();
  if(!round.execution_json.input_cutoff){round.execution_json.input_cutoff=cutoff;await tx.query('UPDATE project_reading_rounds SET execution_json=$2 WHERE id=$1',[id,round.execution_json]);}
  const purpose=round.execution_json.frozen_context.find(c=>c.kind==='following_purpose');
  const context=[...round.execution_json.frozen_context,...(purpose?[{kind:'following_coverage' as const,label:'Actual collection coverage',text:JSON.stringify(coverage),source:purpose.source}]:[])];
  const adapter=topicScope(round.space_id,round.project_id,round.goal_id,round.version_id,context);
  // All decisions/Run admission use the existing kernel under its scope lock;
  // the job never waits for a model or starts another polling loop.
  await tx.query('SAVEPOINT theme_admission');
  try{
   if(round.execution_json.profile_hash!==await nativeProfileFingerprint(tx,round.execution_json.runtime_profile_id))throw new HttpError(409,'Collection execution configuration changed; start a new authorized round',{code:'theme_execution_changed'});
   if(!round.execution_json.frozen_context)throw new HttpError(409,'Frozen collection context missing');
   const contextState=await adapter.contextState(tx,round.execution_json.frozen_context.map(c=>c.source));
   if(contextState.outdated||round.execution_json.frozen_context.some(c=>!contextState.allowed.has(`${c.source.type}:${c.source.id}`)))throw new HttpError(409,'Collection context changed; start a new authorized round');
   const inFlight=await new PgBriefingRepository(tx).findInFlight(adapter.scope);
   if(inFlight&&inFlight.id!==round.briefing_id){await tx.query("UPDATE project_reading_rounds SET status='blocked',error_code='theme_scope_busy' WHERE id=$1",[id]);await tx.query('RELEASE SAVEPOINT theme_admission');return;}
   const outcome=await new InformationBriefingService(tx,config).request(adapter,g.owner_user_id,{kind:'manual',cutoff,themeExecutionHash:round.execution_json.profile_hash,execution:round.execution_json,origin:'job',label:'this confirmed Following'});
   const r=outcome.briefing;
   await tx.query(`UPDATE project_reading_rounds SET briefing_id=$2,status=$3,error_code=$4,updated_at=now() WHERE id=$1`,[id,r.id,r.status==='queued'?'generating':r.status==='ready'&&!(r.outcome==='no_material'&&(!r.coverage.complete||!coverage.complete))?'complete':'blocked',r.error_code??(!r.coverage.complete?'theme_inputs_incomplete':!coverage.complete?'theme_partial_coverage':null)]);
   await tx.query('RELEASE SAVEPOINT theme_admission');
  }catch(error){if(!(error instanceof HttpError))throw error;await tx.query('ROLLBACK TO SAVEPOINT theme_admission');await tx.query('RELEASE SAVEPOINT theme_admission');await tx.query("UPDATE project_reading_rounds SET status='blocked',error_code=$2 WHERE id=$1",[id,typeof error.responseBody==='object'&&(error.responseBody as {code?:string})?.code||'theme_admission_refused']);}
 });
 const terminal=(await db.query<ThemeRound>("SELECT * FROM project_reading_rounds WHERE id=$1 AND status IN ('complete','blocked','superseded')",[id])).rows[0];
 if(terminal)await queueProjectComposition(db,terminal.space_id,terminal.project_id,id);
}
export async function readThemeRounds(db:Queryable,identity:SpaceUserIdentity,goalId:string){
 const g=await liveGoal(db,identity,goalId),adapter=topicScope(identity.spaceId,g.project_id,goalId),repository=new PgBriefingRepository(db);
 const rounds=(await db.query<ThemeRound>('SELECT * FROM project_reading_rounds WHERE space_id=$1 AND goal_id=$2 ORDER BY sequence DESC LIMIT $3',[identity.spaceId,goalId,PROJECT_THEME_LIMITS.history])).rows;
 const published=await repository.latestPublished(adapter.scope);
 return {analysis:g.compatibility_json?.theme_analysis??null,analysis_admission:g.compatibility_json?.theme_analysis?.enabled&&g.compatibility_json?.theme_analysis?.version_id===g.active_version_id?g.compatibility_json?.theme_analysis_admission??null:null,latest:published?await projectBriefing(db,repository,adapter,published):null,rounds:await Promise.all(rounds.map(async r=>{
  const row=r.briefing_id?await repository.get(identity.spaceId,r.briefing_id):null;const shown=row?await projectBriefing(db,repository,adapter,row):null;
  return {id:r.id,sequence:r.sequence,version_id:r.version_id,status:r.status==='superseded'||r.status==='blocked'?r.status:shown?.status==='ready'?'complete':shown?.status==='failed'||shown?.status==='cancelled'?'blocked':r.status,coverage:r.coverage_json,error_code:shown?.error_code??r.error_code,briefing:shown,topic:shown?.visibility==='visible'&&row?.result_json?.topic?row.result_json.topic:null};
 }))};
}

/** Cancel only this analysis, leaving the separately authorized collection and
 * immutable originals intact. Canonical Run cancellation owns stop/ACK. */
export async function cancelThemeRound(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,goalId:string,id:string){
 await assertGoalAnalysisManagement(db,config,identity,goalId);
 const r=(await db.query<ThemeRound>('SELECT * FROM project_reading_rounds WHERE space_id=$1 AND goal_id=$2 AND id=$3',[identity.spaceId,goalId,id])).rows[0];if(!r)throw new HttpError(404,'Theme round not found');
 if(r.briefing_id){
  const row=await new PgBriefingRepository(db).get(identity.spaceId,r.briefing_id);
  if(row?.status==='queued'&&row.run_id){
   const {buildRunOrchestration}=await import('../../runs/orchestrationFactory.js');
   await buildRunOrchestration(config).orchestration.cancelRun({run_id:row.run_id,space_id:identity.spaceId,requested_by_user_id:identity.userId,reason:'Following analysis cancelled'});
   const run=(await db.query<import('../../runs/repository.js').RunRecord>('SELECT * FROM runs WHERE space_id=$1 AND id=$2',[identity.spaceId,row.run_id])).rows[0];
   if(run&&['succeeded','degraded','failed','cancelled','orphaned'].includes(run.status))await (await import('../briefing/settlement.js')).settleBriefingRun(db,run);
   else await db.query("UPDATE project_reading_rounds SET error_code='theme_cancel_requested',updated_at=now() WHERE id=$1",[id]);
  }
 }else await db.query("UPDATE project_reading_rounds SET status='blocked',error_code='theme_cancelled',updated_at=now() WHERE id=$1 AND status IN ('collecting','blocked')",[id]);
 const goal=await liveGoal(db,identity,goalId);await queueProjectComposition(db,identity.spaceId,goal.project_id,id);
 return readThemeRounds(db,identity,goalId);
}
