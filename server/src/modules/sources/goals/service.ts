import {goalCollectionReadableSql,goalItemReadableSql} from './itemVisibility.js';
import {activateGoalVersion,cancelSupersededCollections} from './activation.js';
import {goalFollowState} from './followState.js';
import {ownerExclusion} from './topicJudgment.js';
import {bindNativeSource,NativeSearchPending} from './nativeSearch.js';
import {reconcileNativeSearch} from './nativeSearchResults.js';
import {preflightGoalSource} from './preflight.js';
import {actionPreviewsForViewer,loadProjectChatActionPreviews} from '../../agents/projectChatActionPreviews.js';
import {goalExecutionProgress,goalWithProgress} from './progress.js';
import {canWriteProject} from '../../projects/access.js';
import {sourceGoalError} from './dispatchError.js';
import {assertSafeGoalMessage} from './messageSafety.js';
import {setLegacyGoalPaused,legacyGoalView} from './compatibility.js';
import {retainGoalSample,cleanGoalSamples} from './samples.js';
import {selectGoalResult} from './selection.js';
import {publicGoalContribution,publicGoalValidation,publicGoalRunResult} from './privacy.js';
import {randomUUID} from 'node:crypto';
import {SourceGoalFeedbackRequestSchema,SourceGoalBindingSpecSchema,SourceGoalBudgetSchema,SourceGoalCreateSchema,SourceGoalFollowRequestSchema,SourceGoalVersionWriteSchema,SourceGoalPlanSchema,SourceGoalSaveSampleSchema,type SourceGoalBindingSpec,type SourceGoalFollow} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {resolveContentCreationContext} from '../../access/creationContext.js';
import {PgSchedulerTaskStore} from '../../scheduler/taskStore.js';
import {activeGoalIntent,requireGoal,requireLegacyGoalSource,requireGoalSource,requireAuthorRun,goalSourceFingerprint,type GoalRow} from './access.js';
import {validateGoalSample} from './validation.js';
export interface GoalExecutionResult {/** Already-persisted SourceItems in this bounded result (membership only, never rewritten). */memberItemIds?:string[];/** Collecting Agent's per-material topic signals (judgment, change evidence). */topicSignals?:import('./topicJudgment.js').TopicSignals|null;selection?:{observed_count:number;filtered_count:number;selected_count:number;remaining_count:number};output:unknown;fixture:unknown;source_kind:string;cursor:Record<string,unknown>;cleanup:()=>Promise<void>;filesRoot:string;envelope:unknown;}
export interface GoalExecutionPort {execute(identity:SpaceUserIdentity,g:GoalRow,spec:SourceGoalBindingSpec,cursor:Record<string,unknown>,signal:AbortSignal,fixture?:unknown,inspectOnly?:boolean):Promise<GoalExecutionResult>;}
export class SourceGoalService {
 constructor(readonly db:Pool,readonly config:ServerConfig,readonly executor:GoalExecutionPort){}
 async create(identity:SpaceUserIdentity,raw:unknown){
  const input=SourceGoalCreateSchema.parse(raw);assertSafeGoalMessage(input.intent);
  const scope=await resolveContentCreationContext(this.db,{userId:identity.userId,requestSpaceId:identity.spaceId,projectId:input.project_id});
  const profile=await this.db.query(`SELECT 1 FROM agents a JOIN agent_runtime_profiles p ON p.agent_id=a.id AND p.space_id=a.space_id WHERE a.id=$1 AND a.space_id=$2 AND a.owner_user_id=$3 AND a.status='active' AND p.id=$4 AND p.enabled=true`,[input.agent_id,scope.spaceId,identity.userId,input.runtime_profile_id]);
  if(!profile.rows[0])throw new HttpError(403,'Owned enabled Agent/Profile required');
  const r=await this.db.query(`INSERT INTO source_goals(id,space_id,owner_user_id,project_id,agent_id,runtime_profile_id,intent_json,budget_json,creation_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(space_id,owner_user_id,creation_key) DO NOTHING RETURNING *`,[randomUUID(),scope.spaceId,identity.userId,scope.projectId,input.agent_id,input.runtime_profile_id,{intent:input.intent,includes:input.includes,excludes:input.excludes},input.budget,input.creation_key??null]);if(r.rows[0])return r.rows[0];const existing=(await this.db.query('SELECT * FROM source_goals WHERE space_id=$1 AND owner_user_id=$2 AND creation_key=$3',[scope.spaceId,identity.userId,input.creation_key])).rows[0];if(!existing || existing.intent_json.intent!==input.intent || existing.project_id!==scope.projectId || existing.agent_id!==input.agent_id || existing.runtime_profile_id!==input.runtime_profile_id)throw new HttpError(409,'Goal creation key changed');return existing;
 }
 async list(identity:SpaceUserIdentity){
  const ids=await this.db.query<{id:string}>(`SELECT g.id FROM source_goals g JOIN space_memberships m ON m.space_id=g.space_id AND m.user_id=$2 AND m.status='active' WHERE g.space_id=$1 AND g.status<>'deleted' AND (g.owner_user_id=$2 OR g.project_id IS NOT NULL) ORDER BY g.created_at DESC LIMIT 50`,[identity.spaceId,identity.userId]);
  // A topic the viewer may manage stays listed even when a bound or historical
  // Source is deleted or no longer readable; only authorization refusals of
  // the goal itself skip it, and database faults propagate.
  const result=[];for(const row of ids.rows){let g:GoalRow;try{g=await requireGoal(this.db,identity,row.id);await requireLegacyGoalSource(this.db,this.config,identity,g);}catch(error){if(isAccessRefusal(error))continue;throw error;}
   const versions=await this.db.query<{plan_json:unknown}>('SELECT plan_json FROM source_goal_versions WHERE goal_id=$1',[g.id]);const bindings=await this.db.query<{spec_json:SourceGoalBindingSpec}>('SELECT spec_json FROM source_goal_bindings WHERE goal_id=$1',[g.id]);
   const unavailable=await this.unavailableSources(identity,g,[...bindings.rows.map(b=>b.spec_json),...versions.rows.flatMap(v=>SourceGoalPlanSchema.parse(v.plan_json).sources)]);
   result.push(await goalWithFollowState(this.db,g,unavailable,identity.userId));}
  return {goals:result};
 }
 async resume(identity:SpaceUserIdentity,id:string,versionId:string){
  const result=await this.resumeLocked(identity,id,versionId);
  if('activated' in result&&result.activated)await reconcileNativeSearch(this.db,this.config,id);
  return result;
 }
 private async resumeLocked(identity:SpaceUserIdentity,id:string,versionId:string):Promise<{status:string;prepare?:boolean;activated?:boolean}>{
  return withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true);
   if(g.compatibility_json?.execution_mode==='manual')throw sourceGoalError(409,'source_manual_requires_preview');
   if(await setLegacyGoalPaused(db,identity,id,false,this.config)){await db.query(`UPDATE source_goals SET status='running' WHERE id=$1`,[id]);return {status:'running'};}
   // A confirmed follow paused while still preparing (nothing active yet)
   // resumes the same confirmation: the current plan activates, otherwise the
   // existing bound planning Run is ensured (deduplicated, within the original
   // attempt budget and Profile/spend gates; refusals are recorded).
   const pending=g as GoalRow&{follow_json?:SourceGoalFollow|null};
   if(!g.active_version_id&&pending.follow_json&&g.status==='paused'){
    await db.query(`UPDATE source_goals SET status='draft',updated_at=now() WHERE id=$1`,[id]);
    if(g.current_version_id){const fresh=(await db.query<GoalRow>('SELECT * FROM source_goals WHERE id=$1',[id])).rows[0];const activated=await this.tryActivateInSavepoint(db,identity,fresh,g.current_version_id,pending.follow_json);return {status:activated?'running':'draft',prepare:false,activated:!!activated};}
    await this.ensurePreparation(db,identity,id);
    return {status:(await db.query<{status:string}>('SELECT status FROM source_goals WHERE id=$1',[id])).rows[0].status,prepare:true};
   }
   if(g.active_version_id!==versionId)throw new HttpError(409,'Exact active plan required');
   if(g.status==='running')return {status:'running'};
   if(g.status!=='paused')throw new HttpError(409,'Goal is not paused');
   const activeGoal=await activeGoalIntent(db,g);const activePlan=SourceGoalPlanSchema.parse((await db.query('SELECT plan_json FROM source_goal_versions WHERE id=$1',[versionId])).rows[0].plan_json);
   const bindings=await db.query<{spec_json:SourceGoalBindingSpec;fixture_json:{authority_sha256:string}}>('SELECT spec_json,fixture_json FROM source_goal_bindings WHERE goal_id=$1 AND source_connection_id=ANY($2::varchar[])',[id,activePlan.sources.map(s=>s.source_connection_id)]);
   for(const b of bindings.rows){const c=await preflightGoalSource(db,this.config,identity,activeGoal,b.spec_json);if(goalSourceFingerprint(c)!==b.fixture_json.authority_sha256)throw new HttpError(409,'Source scope changed; new preview required');}
   await db.query(`UPDATE source_goal_bindings SET status='active',retry_at=NULL,fixture_json=fixture_json-'collection_error' WHERE goal_id=$1 AND source_connection_id=ANY($2::varchar[]) AND fixture_json->>'collection_error' IN ('source_native_cancelled','source_native_deadline_exceeded')`,[id,activePlan.sources.map(s=>s.source_connection_id)]);
   await db.query(`UPDATE source_goals SET status='running',updated_at=now() WHERE id=$1`,[id]);
   await new PgSchedulerTaskStore(db).upsert({taskType:'source_goal_tick',taskKey:id,scopeType:'space',scopeId:g.space_id,spaceId:g.space_id,userId:g.owner_user_id,status:'active',nextRunAt:new Date().toISOString(),metadataJson:{version_id:versionId}});
   return {status:'running'};
  });
 }
 async read(identity:SpaceUserIdentity,id:string){
  const goal=await requireGoal(this.db,identity,id);await reconcileNativeSearch(this.db,this.config,id);await requireLegacyGoalSource(this.db,this.config,identity,goal);await cleanGoalSamples(this.db,this.config,id);
  const bindings=await this.db.query('SELECT * FROM source_goal_bindings WHERE space_id=$1 AND goal_id=$2',[identity.spaceId,id]);
  const versions=await this.db.query('SELECT * FROM source_goal_versions WHERE space_id=$1 AND goal_id=$2 ORDER BY revision DESC',[identity.spaceId,id]);
  // The goal stays manageable; content of a Source the viewer can no longer
  // read (deleted, archived, consent narrowed) is redacted below.
  const unavailable=await this.unavailableSources(identity,goal,[...bindings.rows.map(b=>b.spec_json as SourceGoalBindingSpec),...versions.rows.flatMap(v=>SourceGoalPlanSchema.parse(v.plan_json).sources)]);
  const hidden=(connection:unknown)=>typeof connection==='string'&&unavailable.has(connection);
  const previews=await this.db.query('SELECT id,version_id,status,result_json,expires_at,created_at FROM source_goal_previews WHERE space_id=$1 AND goal_id=$2 ORDER BY created_at DESC LIMIT 10',[identity.spaceId,id]);
  const runs=await this.db.query('SELECT * FROM source_goal_runs WHERE space_id=$1 AND goal_id=$2 ORDER BY started_at DESC LIMIT 50',[identity.spaceId,id]);
  const repairs=await this.db.query('SELECT r.* FROM source_goal_repairs r JOIN source_goal_bindings b ON b.id=r.binding_id AND b.space_id=r.space_id WHERE b.space_id=$1 AND b.goal_id=$2 ORDER BY r.created_at DESC LIMIT 20',[identity.spaceId,id]);
  const nativeRuns=await this.db.query(`SELECT r.id,r.status,CASE WHEN s.status='failed' AND s.result_json->>'error'='source_native_cancelled' THEN 'cancelled' WHEN s.status IN ('failed','succeeded') THEN s.status WHEN s.status IN ('accepted','materializing') THEN 'validating' ELSE r.status END AS phase,r.created_at,s.version_id,s.binding_id,s.result_json->>'error' AS error FROM source_goal_runs s JOIN runs r ON r.id=s.result_json->>'native_run_id' AND r.space_id=s.space_id WHERE s.goal_id=$1 AND s.space_id=$2 AND NOT(s.result_json ? 'manual_preview_id') AND NOT(s.result_json ? 'bootstrap_preview_id') ORDER BY r.created_at DESC LIMIT 20`,[id,identity.spaceId]);
  const agentRuns=await this.db.query(`SELECT id,status,created_at,(NOT COALESCE(model_override_json ? 'chat_turn',false) OR EXISTS(SELECT 1 FROM run_events e WHERE e.space_id=runs.space_id AND e.run_id=runs.id AND e.event_type='chat_completed')) AS chat_completed FROM runs WHERE space_id=$1 AND owner_user_id=$3 AND agent_id=$4 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$2 AND COALESCE(contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose','')<>'collect' ORDER BY created_at DESC LIMIT 10`,[identity.spaceId,id,goal.owner_user_id,goal.agent_id]);
  // A completed chat marker is committed after its message. Read history after
  // the marker snapshot so a successful Run cannot hide the final reply.
  const messages=goal.session_id?await new (await import('../../sessions/repository.js')).PgSessionRepository(this.db).listMessages(identity.spaceId,identity.userId,goal.session_id,200,0):[];
  const actionPreviews=agentRuns.rows[0]?actionPreviewsForViewer(await loadProjectChatActionPreviews(this.db,identity.spaceId,agentRuns.rows[0].id),identity.userId).filter(p=>p.proposal_type==='source_channel_activation'&&p.status==='proposed'):[];
  const schedule=await new PgSchedulerTaskStore(this.db).get('source_goal_tick',id);
  // Recent cited changes per material (history for the topic view); changes of
  // Sources this viewer can no longer read are omitted.
  const changes=(await this.db.query<{id:string;source_item_id:string;change_kind:'release'|'update';evidence_url:string;delivery_kind:'baseline'|'evidenced_change';selection_status:'unjudged'|'important'|'not_selected'|'judgment_failed';selection_reason:string|null;judged_by:'topic_rules'|'collection_agent'|'owner'|null;goal_run_id:string;agent_run_id:string|null;detected_at:string;source_connection_id:string}>(`SELECT c.id,c.source_item_id,c.change_kind,c.evidence_url,c.delivery_kind,c.selection_status,c.selection_reason,c.judged_by,c.goal_run_id,c.agent_run_id,c.detected_at,gi.source_connection_id FROM source_goal_item_changes c JOIN source_goal_items gi ON gi.goal_id=c.goal_id AND gi.source_item_id=c.source_item_id JOIN source_items item ON item.id=c.source_item_id AND item.space_id=c.space_id WHERE c.goal_id=$1 AND c.space_id=$2 AND ${goalItemReadableSql('item','$3',true)} AND ${goalCollectionReadableSql('c','$3')} AND NOT(gi.source_connection_id=ANY($4::varchar[])) ORDER BY c.detected_at DESC,c.id LIMIT 50`,[id,identity.spaceId,identity.userId,[...unavailable]])).rows;
  const legacy=await legacyGoalView(this.db,goal);
  const can_manage=goal.owner_user_id===identity.userId&&(!goal.project_id||await canWriteProject(this.db,goal.space_id,goal.project_id,identity.userId));
  return {changes:changes.filter(c=>!hidden(c.source_connection_id)),goal:await goalWithFollowState(this.db,goal,unavailable,identity.userId),can_manage,messages,action_previews:actionPreviews,legacy,agent_runs:agentRuns.rows,native_runs:nativeRuns.rows,schedule:goal.compatibility_json?.scheduler_owner==='legacy'?legacy?.schedule:schedule,repairs:repairs.rows.filter(r=>!hidden(bindings.rows.find(b=>b.id===r.binding_id)?.source_connection_id)).map(r=>({...r,validation_json:r.validation_json?{checks:r.validation_json.checks?.map(publicGoalValidation),scope_unchanged:r.validation_json.scope_unchanged,validated_at:r.validation_json.validated_at}:null})),versions:versions.rows.map(v=>{const plan=v.plan_json as {sources:{source_connection_id:string}[]};const removed=plan.sources.filter(x=>hidden(x.source_connection_id)).map(x=>x.source_connection_id);return removed.length?{...v,plan_json:{...plan,sources:plan.sources.filter(x=>!hidden(x.source_connection_id))},unavailable_sources:removed}:v;}),bindings:bindings.rows.map(b=>hidden(b.source_connection_id)?{id:b.id,goal_id:b.goal_id,source_connection_id:b.source_connection_id,status:b.status,revision:b.revision,unavailable:true,collection_error:'source_unavailable'}:({...b,gaps_json:b.gaps_json?.map((gap:Record<string,unknown>)=>{const {retired_cursor,...publicGap}=gap;return publicGap}),collection_error:b.fixture_json?.collection_error??null,repair_block_reason:b.fixture_json?.repair_block_reason??null,fixture_json:b.fixture_json?{authority_sha256:b.fixture_json.authority_sha256,validation:publicGoalValidation(b.fixture_json.validation),failure:b.fixture_json.failure?{code:b.fixture_json.failure.code,responses:b.fixture_json.failure.responses}:null}:null})),previews:previews.rows.map(p=>({...p,result_json:{...p.result_json,contributions:(p.result_json.contributions??[]).map((c:{source_connection_id:string})=>hidden(c.source_connection_id)?{source_connection_id:c.source_connection_id,status:'unavailable'}:publicGoalContribution(c as never))}})),runs:runs.rows.map(r=>({...r,result_json:r.result_json&&!hidden(bindings.rows.find(b=>b.id===r.binding_id)?.source_connection_id)?publicGoalRunResult(r.result_json):null}))};
 }
 /** Sources this viewer can no longer read for this goal. Only Source access
  * refusals count; unexpected errors propagate instead of masquerading as
  * revocation. */
 private async unavailableSources(identity:SpaceUserIdentity,g:GoalRow,specs:SourceGoalBindingSpec[]){
  const unavailable=new Set<string>();const seen=new Set<string>();
  for(const spec of specs){const key=spec.source_connection_id+':'+spec.source_channel_id;if(seen.has(key)||unavailable.has(spec.source_connection_id))continue;seen.add(key);
   try{await requireGoalSource(this.db,this.config,identity,g,spec,false);}catch(error){if(!isAccessRefusal(error))throw error;unavailable.add(spec.source_connection_id);}}
  return unavailable;
 }
 async writeVersion(identity:SpaceUserIdentity,raw:unknown,runId:string){
  const input=SourceGoalVersionWriteSchema.parse(raw);
  return withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[input.goal_id]);
   const g=await requireGoal(db,identity,input.goal_id,true);await requireAuthorRun(db,g,runId,'explore');
   if(g.revision!==input.expected_revision)throw new HttpError(409,'Goal revision changed or running');
   const sources:SourceGoalBindingSpec[]=[];for(const source of input.plan.sources){if(source.implementation.kind==='agent_search'){sources.push(await bindNativeSource(db,this.config,identity,g,{reason:source.reason,implementation:{kind:'agent_search',query:source.implementation.query},supports_history:false}));}else sources.push(SourceGoalBindingSpecSchema.parse(source));}
   const plan=SourceGoalPlanSchema.parse({...input.plan,sources,search_path_snapshot:g.compatibility_json?.search_path??(sources.some(x=>x.implementation.kind==='agent_search')?'agent':'api')});
   for(const spec of plan.sources)await preflightGoalSource(db,this.config,identity,g,spec,g.status==='paused');
   const count=await db.query('SELECT count(*)::int AS n FROM source_goal_versions WHERE goal_id=$1 AND adjustment_cycle=$2',[g.id,g.adjustment_cycle??0]);if(count.rows[0].n>=g.budget_json.agent_attempts)throw new HttpError(429,'source_goal_exploration_budget_exhausted');
   const id=randomUUID();await db.query('INSERT INTO source_goal_versions(id,space_id,goal_id,revision,plan_json,created_by_run_id,adjustment_cycle) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,g.space_id,g.id,g.revision+1,{...plan,intent_snapshot:{intent:g.intent_json.intent,includes:input.plan.filters?.includes??g.intent_json.includes,excludes:input.plan.filters?.excludes??g.intent_json.excludes}},runId,g.adjustment_cycle??0]);
   await db.query(`UPDATE source_goals SET revision=revision+1,current_version_id=$2,compatibility_json=COALESCE(compatibility_json,'{}'::jsonb)||$3::jsonb,status=CASE WHEN status='paused' OR active_version_id IS NOT NULL AND status='running' THEN status ELSE 'draft' END,updated_at=now() WHERE id=$1`,[g.id,id,plan.title?{display_title:plan.title}:{}]);
   await this.activateConfirmedFirstPlan(db,identity,g as GoalRow&{follow_json?:SourceGoalFollow|null},id);
   return {id,revision:g.revision+1};
  });
 }
 /** A confirmed follow whose plan did not yet exist activates the first plan
  * the bound planning Run writes, inside that write's transaction. Later plans
  * stay drafts until the owner confirms them; activation refusals (scheduling
  * owner, authority, budget) are recorded and leave the plan write intact. */
 private async activateConfirmedFirstPlan(db:import('../../routeUtils/common.js').Queryable,identity:SpaceUserIdentity,g:GoalRow&{follow_json?:SourceGoalFollow|null},versionId:string){
  const follow=g.follow_json;if(!follow||g.active_version_id||g.status==='paused'||follow.version_id&&follow.version_id!==versionId||follow.confirmed_by_user_id!==g.owner_user_id)return;
  await db.query('SAVEPOINT source_goal_follow_activation');
  try{
   const fresh=(await db.query<GoalRow>('SELECT * FROM source_goals WHERE id=$1',[g.id])).rows[0];
   await activateGoalVersion(db,this.config,identity,fresh,{versionId,mode:'continuous',key:follow.idempotency_key,requirePreview:false,reusePreview:true});
   await db.query('RELEASE SAVEPOINT source_goal_follow_activation');
   await db.query(`UPDATE source_goals SET follow_json=follow_json||jsonb_build_object('activated_version_id',$2::text,'last_error',NULL) WHERE id=$1`,[g.id,versionId]);
  }catch(error){
   await db.query('ROLLBACK TO SAVEPOINT source_goal_follow_activation');
   const body=error instanceof HttpError?(error.responseBody as {error?:unknown}|undefined)?.error:undefined;
   const code=typeof body==='string'&&/^source_[a-z_]+$/.test(body)?body:error instanceof Error&&/^source_[a-z_]+$/.test(error.message)?error.message:'source_goal_activation_refused';
   await db.query(`UPDATE source_goals SET follow_json=follow_json||jsonb_build_object('last_error',$2::text) WHERE id=$1`,[g.id,code]);
  }
 }
 async preview(identity:SpaceUserIdentity,id:string,versionId:string,signal:AbortSignal){
  const reservation=await withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true);
   if(g.current_version_id!==versionId || g.status==='paused'&&g.compatibility_json?.execution_mode!=='manual')throw new HttpError(409,'Preview version/state changed');
   const versions=await db.query('SELECT plan_json FROM source_goal_versions WHERE id=$1 AND goal_id=$2 AND space_id=$3',[versionId,id,g.space_id]);if(!versions.rows[0])throw new HttpError(404,'Version not found');
   const pending=await db.query("SELECT 1 FROM source_goal_previews WHERE version_id=$1 AND status='running' AND expires_at>now()",[versionId]);if(pending.rows[0])throw sourceGoalError(409,'source_goal_preview_in_progress');
   const count=await db.query('SELECT count(*)::int AS n FROM source_goal_previews WHERE version_id=$1',[versionId]);if(count.rows[0].n>=3)throw new HttpError(429,'Preview budget exhausted');
   const previewId=randomUUID();await db.query(`INSERT INTO source_goal_previews(id,space_id,goal_id,version_id,status,result_json,expires_at) VALUES($1,$2,$3,$4,'running',$5,now()+interval '15 minutes')`,[previewId,g.space_id,id,versionId,{contributions:SourceGoalPlanSchema.parse(versions.rows[0].plan_json).sources.map(x=>({source_connection_id:x.source_connection_id,status:'queued'}))}]);
   return {g,previewId,plan:SourceGoalPlanSchema.parse(versions.rows[0].plan_json)};
  });
  const {previewId,plan}=reservation;const g={...reservation.g,intent_json:plan.intent_snapshot??reservation.g.intent_json,execution_filters:plan.filters,execution_search_path:plan.search_path_snapshot??'api',execution_scope:previewId};const contributions:Record<string,unknown>[]=[];
  for(const spec of plan.sources){
   try{
    const authority=goalSourceFingerprint(await preflightGoalSource(this.db,this.config,identity,g,spec));
    const rawRun=await this.executor.execute(identity,g,spec,{},signal);
    let run;try{run=await selectGoalResult(this.db,g,spec,{},rawRun);}catch(e){await rawRun.cleanup();throw e;}
    try{const check=validateGoalSample(run.output,{allowUndated:run.source_kind==='search',budget:g.budget_json,...g.intent_json});
     contributions.push(await retainGoalSample(this.db,this.config,spec.source_connection_id,{source_connection_id:spec.source_connection_id,source_kind:run.source_kind,status:check.ok?'succeeded':'insufficient',authority_sha256:authority,validation:publicGoalValidation(check),selection:run.selection,output:check.output,capture_policy:(run.envelope as {capture_policy?:string}).capture_policy,retention_policy:(run.envelope as {retention_policy?:string}).retention_policy,fixture:run.fixture,implementation:spec.implementation}));
    }finally{await run.cleanup();}
   }catch(error){if(error instanceof NativeSearchPending){contributions.push({source_connection_id:spec.source_connection_id,status:'queued',run_id:error.runId,usage:{physical_requests:null,provider_quota:null,cost:null}});continue;}contributions.push({source_connection_id:spec.source_connection_id,status:'failed',error:error instanceof Error && /^source_[a-z_]+$/.test(error.message)?error.message:'source_execution_refused'});}
  }
  return withDbTransaction(this.db,async db=>{
   await requireGoal(db,identity,id,true);const latest=(await db.query('SELECT result_json FROM source_goal_previews WHERE id=$1 FOR UPDATE',[previewId])).rows[0];
   const merged=contributions.map(c=>{const done=latest.result_json.contributions?.find((x:{source_connection_id:string;run_id?:string;status:string})=>x.source_connection_id===c.source_connection_id&&x.run_id&&x.status!=='queued');return done??c;});
   const ready=merged.length===plan.sources.length&&merged.every(c=>c.status==='succeeded');const pending=merged.some(c=>c.status==='queued');
   const result={version_id:versionId,contributions:merged,limitations:plan.limitations,complete:ready,observed_at:new Date().toISOString()};
   const stored=await db.query(`UPDATE source_goal_previews SET status=$2,result_json=$3 WHERE id=$1 AND EXISTS(SELECT 1 FROM source_goals WHERE id=source_goal_previews.goal_id AND (status NOT IN ('paused','deleted') OR status='paused' AND compatibility_json->>'execution_mode'='manual')) RETURNING id`,[previewId,pending?'running':ready?'ready':'partial',result]);if(!stored.rows[0])throw new HttpError(409,'Goal stopped before preview storage');
   if(!pending)await db.query(`UPDATE source_goals SET status=$3,updated_at=now() WHERE id=$1 AND current_version_id=$2 AND status NOT IN ('paused','deleted','running')`,[id,versionId,ready?'preview_ready':'needs_information']);
   return {id:previewId,...result,contributions:merged.map(publicGoalContribution)};
  });
 }
 /** Optional manual save of one fresh exact-version Agent-search preview as
  * reading material. It never starts continuous following (that is follow()). */
 async saveSample(identity:SpaceUserIdentity,id:string,raw:unknown){
  const input=SourceGoalSaveSampleSchema.parse(raw);
  const result=await withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true);
   if(g.start_key===input.idempotency_key && g.active_version_id===input.version_id){if(g.compatibility_json?.execution_mode!=='manual')throw sourceGoalError(409,'source_native_stale_result');return {goal_id:id,version_id:g.active_version_id,status:g.status,_promoted:false};}
   if((g.status!=='preview_ready' && g.status!=='running' && !(g.status==='paused'&&g.compatibility_json?.execution_mode==='manual')) || g.current_version_id!==input.version_id)throw new HttpError(409,'Plan changed or already started');
   await activateGoalVersion(db,this.config,identity,g,{versionId:input.version_id,mode:'manual',key:input.idempotency_key,previewId:input.preview_id,requirePreview:true,reusePreview:false});
   return {goal_id:id,version_id:input.version_id,status:'running',_promoted:true};
  });
  await reconcileNativeSearch(this.db,this.config,id);
  if(result._promoted)await cancelSupersededCollections(this.db,this.config,identity,id,input.version_id);
  const {_promoted,...publicResult}=result;return publicResult;
 }
 /** One owner confirmation of topic, frequency and budget starts continuous
  * following. No manual preview is required; an exact current plan activates
  * now (reusing a fresh preview's Agent-search results), otherwise the
  * confirmation persists and the first plan written by the bound planning Run
  * activates. Source preflight, scheduling ownership, CAS and spend admission
  * stay in the shared activation path; new permissions keep their own gates. */
 async follow(identity:SpaceUserIdentity,id:string,raw:unknown){
  const input=SourceGoalFollowRequestSchema.parse(raw);
  const result=await withDbTransaction(this.db,db=>this.followLocked(db,identity,id,input));
  await this.afterFollow(identity,id,result);
  return result;
 }
 /** Post-commit work of a follow that activated a version. */
 async afterFollow(identity:SpaceUserIdentity,id:string,result:{activated:boolean;follow:SourceGoalFollow|null}){
  if(result.activated&&result.follow?.activated_version_id){await reconcileNativeSearch(this.db,this.config,id);await cancelSupersededCollections(this.db,this.config,identity,id,result.follow.activated_version_id);}
 }
 /** The follow confirmation inside the caller's transaction (also used by
  * topic creation, so creating and confirming commit together). */
 async followLocked(db:import('../../routeUtils/common.js').Queryable,identity:SpaceUserIdentity,id:string,input:import('@rainver/protocol').SourceGoalFollowRequest){
  {
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true) as GoalRow&{follow_json?:SourceGoalFollow|null};
   // A manual-save goal rests paused; an ordinary paused follow resumes instead.
   if(g.status==='paused'&&g.compatibility_json?.execution_mode!=='manual')throw sourceGoalError(409,'source_goal_paused_resume_required');
   const prior=g.follow_json??null;
   if(prior?.idempotency_key===input.idempotency_key){
    if((input.version_id??null)!==prior.version_id||(input.interval_seconds??prior.interval_seconds)!==prior.interval_seconds||(input.requests_per_run??prior.requests_per_run)!==prior.requests_per_run||(input.items_per_source??prior.items_per_source)!==prior.items_per_source)throw sourceGoalError(409,'source_goal_follow_key_changed');
    // A replay ensures the confirmed bootstrap exists (crash after commit,
    // or a refusal since fixed). It never activates a later draft of an
    // already active goal; preparation is deduplicated and attempt-bounded.
    if(!g.active_version_id){
     if(g.current_version_id&&(!prior.version_id||prior.version_id===g.current_version_id)){const activated=await this.tryActivateInSavepoint(db,identity,g,g.current_version_id,prior);if(activated)return {goal_id:id,status:'running',follow:activated,activated:true,prepare:false};}
     else if(!g.current_version_id)await this.ensurePreparation(db,identity,id);
    }
    const current=(await db.query<{follow_json:SourceGoalFollow}>('SELECT follow_json FROM source_goals WHERE id=$1',[id])).rows[0].follow_json;
    return {goal_id:id,status:g.status,follow:current,activated:false,prepare:false};
   }
   if(input.version_id&&input.version_id!==g.current_version_id)throw new HttpError(409,'Plan changed; confirm the current plan');
   const budget=SourceGoalBudgetSchema.parse({...g.budget_json,...(input.interval_seconds?{interval_seconds:input.interval_seconds}:{}),...(input.requests_per_run?{requests_per_run:input.requests_per_run}:{}),...(input.items_per_source?{items_per_source:input.items_per_source}:{})});
   const follow:SourceGoalFollow={confirmed_at:new Date().toISOString(),confirmed_by_user_id:identity.userId,idempotency_key:input.idempotency_key,version_id:input.version_id??null,interval_seconds:budget.interval_seconds,requests_per_run:budget.requests_per_run,items_per_source:budget.items_per_source,activated_version_id:null,reused_preview_id:null,last_error:null};
   await db.query('UPDATE source_goals SET budget_json=$2,follow_json=$3,updated_at=now() WHERE id=$1',[id,budget,follow]);
   const goal={...g,budget_json:budget,follow_json:follow};
   const target=input.version_id??g.current_version_id;
   // Intent and its preparation commit together: no window where a confirmed
   // follow exists without durable background work (or a recorded refusal).
   if(!target){await this.ensurePreparation(db,identity,id);const current=(await db.query<{follow_json:SourceGoalFollow}>('SELECT follow_json FROM source_goals WHERE id=$1',[id])).rows[0].follow_json;return {goal_id:id,status:g.status,follow:current,activated:false,prepare:true};}
   // Already continuously following this exact version; a manual-save goal still converts.
   if(target===g.active_version_id&&g.status==='running'&&g.compatibility_json?.execution_mode!=='manual')return {goal_id:id,status:g.status,follow,activated:false,prepare:false};
   const activation=await activateGoalVersion(db,this.config,identity,goal,{versionId:target,mode:'continuous',key:input.idempotency_key,requirePreview:false,reusePreview:true});
   follow.activated_version_id=target;follow.reused_preview_id=activation.reusedPreviewId;
   await db.query('UPDATE source_goals SET follow_json=$2 WHERE id=$1',[id,follow]);
   return {goal_id:id,status:'running',follow,activated:true,prepare:false};
  }
 }
 /** Background preparation is the existing bound planning Run and its queued
  * job, written in the caller's transaction (deduplicated and attempt-bounded
  * by queueSourceGoalAgent). A refusal rolls back only this savepoint and is
  * recorded as the follow's stable reason; database faults propagate. */
 private async ensurePreparation(db:import('../../routeUtils/common.js').Queryable,identity:SpaceUserIdentity,id:string){
  const {queueSourceGoalAgent}=await import('./agent.js');
  await db.query('SAVEPOINT source_goal_follow_preparation');
  try{await queueSourceGoalAgent(db,this.config,identity,id,'explore');await db.query('RELEASE SAVEPOINT source_goal_follow_preparation');await db.query(`UPDATE source_goals SET follow_json=follow_json||jsonb_build_object('last_error',NULL) WHERE id=$1`,[id]);}
  catch(error){await db.query('ROLLBACK TO SAVEPOINT source_goal_follow_preparation');if(!(error instanceof HttpError))throw error;
   const body=(error.responseBody as {error?:unknown}|undefined)?.error;const code=typeof body==='string'&&/^source_[a-z_]+$/.test(body)?body:'source_goal_preparation_failed';
   await db.query(`UPDATE source_goals SET follow_json=follow_json||jsonb_build_object('last_error',$2::text) WHERE id=$1`,[id,code]);}
 }
 /** Retry a confirmed first activation (nothing active yet) inside a savepoint. */
 private async tryActivateInSavepoint(db:import('../../routeUtils/common.js').Queryable,identity:SpaceUserIdentity,g:GoalRow,versionId:string,follow:SourceGoalFollow):Promise<SourceGoalFollow|null>{
  await db.query('SAVEPOINT source_goal_follow_replay');
  try{const activation=await activateGoalVersion(db,this.config,identity,g,{versionId,mode:'continuous',key:follow.idempotency_key,requirePreview:false,reusePreview:true});await db.query('RELEASE SAVEPOINT source_goal_follow_replay');
   const next={...follow,activated_version_id:versionId,reused_preview_id:activation.reusedPreviewId,last_error:null};await db.query('UPDATE source_goals SET follow_json=$2 WHERE id=$1',[g.id,next]);return next;}
  catch(error){await db.query('ROLLBACK TO SAVEPOINT source_goal_follow_replay');if(!(error instanceof HttpError)&&!(error instanceof Error&&/^source_[a-z_]+$/.test(error.message)))throw error;
   const body=error instanceof HttpError?(error.responseBody as {error?:unknown}|undefined)?.error:undefined;const code=typeof body==='string'&&/^source_[a-z_]+$/.test(body)?body:error instanceof Error&&/^source_[a-z_]+$/.test(error.message)?error.message:'source_goal_activation_refused';
   await db.query(`UPDATE source_goals SET follow_json=follow_json||jsonb_build_object('last_error',$2::text) WHERE id=$1`,[g.id,code]);return null;}
 }
 /** Owner feedback on a followed topic. Only tightening applies here: an
  * excluded origin/term or "not relevant" marks matching members not selected
  * (owner-judged, kept and still readable under "all") and governs later
  * judgments; slow_down lengthens the interval without an earlier check.
  * Faster collection, more budget or new Sources go through follow and the
  * existing Source/credential gates. Each key applies once. */
 async feedback(identity:SpaceUserIdentity,id:string,raw:unknown){
  const input=SourceGoalFeedbackRequestSchema.parse(raw);
  return withDbTransaction(this.db,async db=>{
   await db.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);const g=await requireGoal(db,identity,id,true) as GoalRow&{follow_json?:SourceGoalFollow|null};
   const follow=g.follow_json;if(!follow)throw sourceGoalError(409,'source_goal_feedback_requires_follow');
   // The key carries a hash of its payload: a replay is a no-op, a reuse with
   // a different payload is refused like follow's changed-key replay.
   const {createHash}=await import('node:crypto');const fingerprint=input.idempotency_key+'|'+createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0,24);
   const prior=(follow.feedback_keys??[]).find(k=>k===input.idempotency_key||k.startsWith(input.idempotency_key+'|'));
   if(prior){if(prior!==fingerprint)throw sourceGoalError(409,'source_goal_feedback_key_changed');return {applied:false,duplicate:true,kind:input.kind,affected:0};}
   const rules={excluded_origins:[...(follow.rules?.excluded_origins??[])],excluded_terms:[...(follow.rules?.excluded_terms??[])]};let affected=0;let budget=g.budget_json;
   const mark=async(ids:string[],reason:(row:{source_uri:string|null;title:string})=>string|null)=>{
    const rows=(await db.query<{source_item_id:string;source_uri:string|null;title:string}>(`SELECT gi.source_item_id,i.source_uri,i.title FROM source_goal_items gi JOIN source_items i ON i.id=gi.source_item_id AND i.space_id=gi.space_id WHERE gi.goal_id=$1 AND gi.space_id=$2 AND ($3::varchar[] IS NULL OR gi.source_item_id=ANY($3::varchar[]))`,[id,g.space_id,ids.length?ids:null])).rows;
    for(const row of rows){const why=reason(row);if(!why)continue;await db.query(`UPDATE source_goal_items SET selection_status='not_selected',selection_reason=$3,selection_source='owner_feedback',judged_by='owner',judged_at=now(),updated_at=now() WHERE goal_id=$1 AND source_item_id=$2`,[id,row.source_item_id,why]);affected++;}
   };
   if(input.kind==='exclude_origin'){const origin=new URL(input.origin).origin;if(!rules.excluded_origins.includes(origin)){if(rules.excluded_origins.length>=50)throw sourceGoalError(409,'source_goal_feedback_limit');rules.excluded_origins.push(origin);}await mark([],row=>ownerExclusion(row,{excluded_origins:[origin]}));}
   else if(input.kind==='exclude_term'){const term=input.term;if(!rules.excluded_terms.some(t=>t.toLowerCase()===term.toLowerCase())){if(rules.excluded_terms.length>=50)throw sourceGoalError(409,'source_goal_feedback_limit');rules.excluded_terms.push(term);}await mark([],row=>ownerExclusion(row,{excluded_terms:[term]}));}
   else if(input.kind==='not_relevant'){const member=(await db.query('SELECT 1 FROM source_goal_items WHERE goal_id=$1 AND space_id=$2 AND source_item_id=$3',[id,g.space_id,input.source_item_id])).rows[0];if(!member)throw new HttpError(404,'Material is not part of this topic');await mark([input.source_item_id],()=>'Marked not relevant by you');}
   else{
    // Only slowing down is direct; a faster cadence needs a new confirmation.
    if(input.interval_seconds<=g.budget_json.interval_seconds)throw sourceGoalError(409,'source_goal_feedback_requires_confirmation');
    budget=SourceGoalBudgetSchema.parse({...g.budget_json,interval_seconds:input.interval_seconds});
    await db.query('UPDATE source_goals SET budget_json=$2,updated_at=now() WHERE id=$1',[id,budget]);
    await db.query(`UPDATE scheduler_tasks SET next_run_at=GREATEST(next_run_at,COALESCE(last_run_at,now())+make_interval(secs=>$2::int)) WHERE task_type='source_goal_tick' AND task_key=$1 AND next_run_at IS NOT NULL`,[id,input.interval_seconds]);
   }
   const next:SourceGoalFollow={...follow,rules,feedback_keys:[...(follow.feedback_keys??[]),fingerprint].slice(-50)};
   await db.query('UPDATE source_goals SET follow_json=$2 WHERE id=$1',[id,next]);
   return {applied:true,duplicate:false,kind:input.kind,affected};
  });
 }
 async stop(identity:SpaceUserIdentity,id:string,deleted=false){
  const result=await withDbTransaction(this.db,async db=>{await requireGoal(db,identity,id,true);await setLegacyGoalPaused(db,identity,id,true,this.config);
   await db.query('UPDATE source_goals SET status=$2,updated_at=now() WHERE id=$1',[id,deleted?'deleted':'paused']);
   await db.query("UPDATE source_goal_runs SET result_json=result_json||'{\"goal_stopped\":true}'::jsonb WHERE goal_id=$1 AND status='queued' AND result_json ? 'native_run_id'",[id]);
   if(deleted)await cleanGoalSamples(db,this.config,id,true);
   await db.query(`UPDATE scheduler_tasks SET status=$2,next_run_at=NULL WHERE task_type='source_goal_tick' AND task_key=$1`,[id,deleted?'archived':'paused']);
   return {status:deleted?'deleted':'paused'};
  });
  const runs=await this.db.query<{id:string}>(`SELECT id FROM runs WHERE space_id=$1 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$2 AND status IN ('queued','running','waiting_for_review','waiting_for_dependency','cancelling')`,[identity.spaceId,id]);
  if(runs.rows.length){const {buildRunOrchestration}=await import('../../runs/orchestrationFactory.js');const {orchestration}=buildRunOrchestration(this.config);for(const run of runs.rows)await orchestration.cancelRun({run_id:run.id,space_id:identity.spaceId,requested_by_user_id:identity.userId,reason:'Source goal stopped'});}
  return result;
 }
}

async function goalWithFollowState(db:Pool,g:GoalRow,unavailable:ReadonlySet<string>=new Set(),viewerId=g.owner_user_id){const execution=await goalExecutionProgress(db,g);return {...goalWithProgress(g,execution),follow_state:await goalFollowState(db,g,execution,unavailable,viewerId)};}
function isAccessRefusal(error:unknown){return error instanceof HttpError&&[403,404].includes(error.statusCode);}
