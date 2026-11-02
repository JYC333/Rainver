import {readingRunContext} from '../readingMethods/followingContext.js';
import {readingMethodOf,assertFrozenReadingMethod} from '../../prompts/index.js';
import {assertReadingAudience,assertReadingRunEgress} from '../readingMethods/context.js';
import {recoverGoalWatermark} from './watermark.js';
import {materialRunExpired} from '../materialProcessing/executionBudget.js';
import {agentReadingPolicy} from '../materialProcessing/policy.js';
import {agentReadingMetadata} from '../materialProcessing/documents.js';
import {CustomSourceHandlerOutputSchema,SourceMaterialSubmissionSchema} from '@rainver/protocol';
import {PgConversationBackendRepository} from '../../sessions/conversationBackendRepository.js';
import {resolveSessionConfig} from '../../sessions/sessionConfig.js';
import {nativeProfileFingerprint} from './nativeRoute.js';
import {randomUUID} from 'node:crypto';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool} from '../../routeUtils/common.js';
import {requireGoal,activeGoalIntent,goalSourceFingerprint,type GoalRow} from './access.js';
import {preflightGoalSource} from './preflight.js';
import {validateGoalSample} from './validation.js';
import {materializeGoalBatch} from './materialization.js';
import {selectGoalResult} from './selection.js';
import type {GoalExecutionResult} from './service.js';
import type {GoalBindingRow} from './worker.js';
import type {SourceGoalBindingSpec} from '@rainver/protocol';
/** Settlement and read/restart recovery use the same idempotent acceptance.
 * The model cannot choose its collection identity or write any collected item. */
export async function reconcileNativeSearch(db:Pool,config:ServerConfig,goalId:string,settlingRunId?:string){
 const rows=await db.query(`SELECT id FROM source_goal_runs WHERE goal_id=$1 AND status='queued' AND result_json ? 'native_run_id' AND ($2::varchar IS NULL OR result_json->>'native_run_id'=$2) ORDER BY started_at LIMIT 20`,[goalId,settlingRunId??null]);
 for(const row of rows.rows){
 // A terminal callback projects only its own result; deadline commands belong
 // to the ordinary read/tick recovery path outside the finalization lock.
 const candidate=settlingRunId?null:(await db.query("SELECT r.id,r.space_id,r.instructed_by_user_id,r.started_at,r.contract_snapshot_json FROM source_goal_runs s JOIN runs r ON r.id=s.result_json->>'native_run_id' WHERE s.id=$1 AND r.status IN ('queued','running','waiting_for_review','waiting_for_dependency','cancelling')",[row.id])).rows[0];const overdue=candidate&&materialRunExpired(candidate)?candidate:null;if(overdue){await db.query("UPDATE source_goal_runs SET result_json=result_json||'{\"deadline_exceeded\":true}'::jsonb WHERE id=$1",[row.id]);const {buildRunOrchestration}=await import('../../runs/orchestrationFactory.js');await buildRunOrchestration(config).orchestration.cancelRun({run_id:overdue.id,space_id:overdue.space_id,requested_by_user_id:overdue.instructed_by_user_id,reason:'Source collection deadline exceeded'});}
 await withDbTransaction(db,async tx=>{
  const audit=(await tx.query(`SELECT * FROM source_goal_runs WHERE id=$1 AND status='queued' FOR UPDATE`,[row.id])).rows[0];if(!audit)return;const p=audit.result_json as {native_run_id:string;spec:SourceGoalBindingSpec;authority_sha256:string;preview_id:string|null;route:unknown;binding_revision:number|null;cursor_before:Record<string,unknown>};
  const run=(await tx.query(`SELECT * FROM runs WHERE id=$1 AND space_id=$2`,[p.native_run_id,audit.space_id])).rows[0];if(!run||!overdue&&['queued','running','waiting_for_review','waiting_for_dependency','cancelling'].includes(run.status))return;
  let error:string|null=null;let output:unknown;let authority=p.authority_sha256;let goal:GoalRow;let validation:unknown;let selection:unknown;let insufficient=false;let coverage:unknown;let topicSignals:import('./topicJudgment.js').TopicSignals|null=null;let capturePolicy='reference_only';let retentionPolicy='metadata_only';
  try{
   if(overdue||audit.result_json.deadline_exceeded===true)throw new Error('source_native_deadline_exceeded');
   if(audit.result_json.goal_stopped===true)throw new Error('source_native_cancelled');
   const correctionOnly=run.status==='degraded'?(await tx.query("SELECT error_code,metadata_json FROM run_events WHERE run_id=$1 AND event_type='action_completed' AND status='failed'",[run.id])).rows:null;
   const corrected=correctionOnly&&correctionOnly.length>0&&correctionOnly.every(e=>e.metadata_json?.action_id==='source.material.submit'&&['source_material_submission_invalid',...(audit.result_json.search_submission?['source_material_submission_already_recorded','source_material_submission_limit']:[])].includes(e.error_code??e.metadata_json?.error_code));
   if(run.status!=='succeeded'&&!corrected)throw new Error(run.status==='cancelled'?'source_native_cancelled':'source_native_failed');
   const contract=run.contract_snapshot_json?.workflow_input_json?.source_goal;if(contract?.purpose!=='collect'||contract.collection_id!==audit.id||contract.version_id!==audit.version_id||contract.source_connection_id!==p.spec.source_connection_id)throw new Error('source_native_context_refused');
   const identity={spaceId:audit.space_id,userId:run.instructed_by_user_id};goal=await requireGoal(tx,identity,goalId,true);if((goal.status==='deleted'||goal.status==='paused'&&!(p.preview_id&&goal.compatibility_json?.execution_mode==='manual'))||goal.owner_user_id!==run.instructed_by_user_id||goal.agent_id!==run.agent_id||goal.runtime_profile_id!==run.requested_runtime_profile_id)throw new Error('source_authority_revoked');
   const profile=await tx.query(`SELECT 1 FROM agents a JOIN agent_runtime_profiles p ON p.agent_id=a.id WHERE a.id=$1 AND a.space_id=$2 AND a.owner_user_id=$3 AND a.status='active' AND p.id=$4 AND p.enabled=true`,[goal.agent_id,goal.space_id,goal.owner_user_id,goal.runtime_profile_id]);if(!profile.rows.length)throw new Error('source_authority_revoked');
   if(p.spec.implementation.kind!=='agent_search'||p.spec.implementation.route?.profile_sha256!==await nativeProfileFingerprint(tx,goal.runtime_profile_id))throw new Error('source_native_route_changed');
   const selected=(await new PgConversationBackendRepository(tx).listOptions(goal.space_id,goal.owner_user_id,goal.agent_id)).find(o=>o.runtime_profile_id===goal.runtime_profile_id);if(!selected||selected.usable===false)throw new Error('source_native_route_changed');await resolveSessionConfig(p.spec.implementation.route.session_config,async()=>[],selected.session_config_options??[]);
   const c=await preflightGoalSource(tx,config,identity,{...goal,execution_search_path:'agent'},p.spec);if(goalSourceFingerprint(c)!==authority)throw new Error('source_authority_revoked');
   const version=(await tx.query('SELECT plan_json FROM source_goal_versions WHERE id=$1 AND goal_id=$2',[audit.version_id,goalId])).rows[0];if(!version)throw new Error('source_native_context_refused');
   if(p.preview_id){const preview=(await tx.query(`SELECT 1 FROM source_goal_previews WHERE id=$1 AND version_id=$2 AND status='running' AND expires_at>now()`,[p.preview_id,audit.version_id])).rows[0];if(!preview||goal.current_version_id!==audit.version_id)throw new Error('source_native_stale_result');}else if(goal.active_version_id!==audit.version_id||goal.status!=='running')throw new Error('source_native_stale_result');
   const method=readingMethodOf(run);if(method){await assertFrozenReadingMethod(tx,method,await readingRunContext(tx,identity,run,method.project_id,c.visibility==='private'));await assertReadingAudience(tx,identity,null,null,c.id);await assertReadingRunEgress(tx,run,c.id);}
   const submission=SourceMaterialSubmissionSchema.safeParse(audit.result_json.search_submission);
   if(!submission.success)throw new Error('source_material_submission_missing');
   const supplied=submission.data;const policy=agentReadingPolicy(c);capturePolicy=policy.capture;retentionPolicy=policy.retention;
   if(supplied.items.some(item=>(!policy.summary&&item.summary)||(!policy.content&&item.content)))throw new Error('source_policy_refused');
   if(supplied.processing_id!==audit.id)throw new Error('source_native_context_refused');
   if(supplied.status==='failed')throw new Error('source_material_'+supplied.failure!.code);
   const unique=new Map(supplied.items.map(item=>[new URL(item.url).href,item]));
   const observed=[...unique.entries()];const parsed=observed.slice(0,goal.budget_json.items_per_source);
   coverage={...supplied.coverage,observed_items:supplied.items.length,unique_items:observed.length,returned_items:parsed.length,truncated:supplied.coverage.truncated||observed.length>parsed.length,exhaustive:false,verification:'agent_provided_unverified'};
   // Stated publication time only, never observation time; a future claim is unknown.
   const stated=(t:string|null|undefined)=>t&&Number.isFinite(Date.parse(t))&&Date.parse(t)<=Date.now()+5*60_000?new Date(t).toISOString():null;
   topicSignals={items:Object.fromEntries(parsed.map(([url,item])=>[url,{judgment:item.topic_judgment??null,change:item.change??null}])),judgment_failure:supplied.judgment_failure?.message??null};
   output={contract_version:'custom_source.handler_output.v1',items:parsed.map(([url,item])=>({external_id:url,source_uri:url,title:item.title,published_at:stated(item.published_at),excerpt:item.summary,reading_content:item.content,snapshots:[],evidence:[],metadata:{...(item.content?agentReadingMetadata(item.content):item.summary?{reading_content_kind:'other',reading_content_format:'agent_summary',reading_sources:[url]}:{}),reading_unavailable_reason:item.content?null:item.unavailable_reason??'not_read',agent_run_id:run.id,reading_method_provenance:readingMethodOf(run),observed_at:item.observed_at,result_provenance:'agent_provided_unverified'}}))};
   const intent=version.plan_json.intent_snapshot??goal.intent_json;const excluded=version.plan_json.filters?.excluded_origins??[];const rawItems=(output as {items:{source_uri:string}[]}).items;const filtered={...(output as object),items:rawItems.filter(i=>!excluded.some((x:string)=>new URL(x).origin===new URL(i.source_uri).origin))};const check=validateGoalSample(filtered,{allowUndated:true,allowEmpty:!p.preview_id,budget:goal.budget_json,...intent});validation=check;selection={observed_count:rawItems.length,filtered_count:rawItems.length-check.count,selected_count:check.count,remaining_count:0};insufficient=!!p.preview_id&&!check.count&&check.errors.every(e=>e==='empty_result');if(!check.ok&&!insufficient)throw new Error('source_native_output_invalid');output=check.output;
   if(!p.preview_id){
    const b=(await tx.query('SELECT * FROM source_goal_bindings WHERE id=$1 AND goal_id=$2',[audit.binding_id,goalId])).rows[0];if(!b||b.revision!==p.binding_revision||JSON.stringify(b.spec_json)!==JSON.stringify(p.spec)||b.status!=='collecting')throw new Error('source_native_stale_result');
    const token=randomUUID();const lease=await tx.query(`UPDATE source_goal_bindings SET lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1 AND (lease_token IS NULL OR lease_until<now()) RETURNING id`,[b.id,token]);if(!lease.rows.length)return;
    // Release the claim transaction before canonical materialization uses its
    // own atomic item + business cursor transaction. Retry deduplicates IDs.
    await tx.query('UPDATE source_goal_runs SET result_json=result_json||$2::jsonb WHERE id=$1',[audit.id,{accepted_output:output,topic_signals:topicSignals,materialization_token:token}]);
   }
  }catch(e){if(e&&typeof e==='object'&&'code' in e&&typeof e.code==='string'&&/^\d|^ECONN|^ENOT/.test(e.code))throw e;error=e instanceof Error&&/^source_[a-z_]+$/.test(e.message)?e.message:'source_native_output_invalid';}
  if(p.preview_id){
   const preview=(await tx.query('SELECT result_json FROM source_goal_previews WHERE id=$1 FOR UPDATE',[p.preview_id])).rows[0];if(preview){const prior=preview.result_json.contributions??[];const contribution={source_connection_id:p.spec.source_connection_id,source_kind:'search',status:error?'failed':insufficient?'insufficient':'succeeded',validation,selection,coverage,...(error?{error}:{output,topic_signals:topicSignals,authority_sha256:authority,capture_policy:capturePolicy,retention_policy:retentionPolicy,implementation:p.spec.implementation}),run_id:run.id,usage:{physical_requests:null,provider_quota:null,cost:null,control:'canonical_run_budget'}};const contributions=[...prior.filter((x:{source_connection_id:string})=>x.source_connection_id!==p.spec.source_connection_id),contribution];const pending=contributions.some((x:{status:string})=>x.status==='queued');const ready=contributions.length>0&&contributions.every((x:{status:string})=>x.status==='succeeded');await tx.query(`UPDATE source_goal_previews SET status=$2,result_json=result_json||$3::jsonb WHERE id=$1 AND status='running'`,[p.preview_id,pending?'running':ready?'ready':'partial',{contributions,complete:ready,observed_at:new Date().toISOString()}]);if(!pending)await tx.query(`UPDATE source_goals SET status=$3 WHERE id=$1 AND current_version_id=$2 AND status NOT IN ('paused','deleted','running')`,[goalId,audit.version_id,ready?'preview_ready':'needs_information']);}
  }
  if(error&&audit.binding_id){const stopped=(await tx.query("SELECT status FROM source_goals WHERE id=$1",[goalId])).rows[0]?.status;const explicitStop=error==='source_native_cancelled'&&(audit.result_json.goal_stopped===true||['paused','deleted'].includes(stopped));const pause=error!=='source_native_failed';await tx.query(`UPDATE source_goal_bindings SET failures=failures+CASE WHEN $4 THEN 0 ELSE 1 END,status=CASE WHEN $4 THEN 'active' WHEN $3 OR failures+1>=3 THEN 'paused' ELSE 'cooldown' END,retry_at=CASE WHEN $4 OR $3 OR failures+1>=3 THEN NULL ELSE now()+interval '1 hour' END,fixture_json=CASE WHEN $4 THEN fixture_json-'collection_error' ELSE fixture_json||$2::jsonb END WHERE id=$1 AND status='collecting' AND revision IS NOT DISTINCT FROM $5::int`,[audit.binding_id,{collection_error:error},pause,explicitStop,p.binding_revision]);}
  await tx.query(`UPDATE source_goal_runs SET status=$2::varchar,result_json=result_json||$3::jsonb,ended_at=CASE WHEN $2::varchar='accepted' THEN NULL ELSE now() END WHERE id=$1`,[audit.id,error?'failed':p.preview_id?'succeeded':'accepted',{...(error?{error}:{}),...(p.preview_id?{}:{accepted_output:output})}]);
 });}
 // Persist submitted output via the sole existing materializer, then commit
 // audit success. A crash between them replays stable-ID dedupe, not the model.
 const accepted=await db.query(`SELECT * FROM source_goal_runs WHERE goal_id=$1 AND (status='accepted' OR (status='materializing' AND (result_json->>'materialization_lease_until')::timestamptz<now())) ORDER BY started_at LIMIT 20`,[goalId]);
 for(const pending of accepted.rows){
  const claim=await db.query(`UPDATE source_goal_runs SET status='materializing',result_json=result_json||jsonb_build_object('materialization_lease_until',now()+interval '5 minutes') WHERE id=$1 AND (status='accepted' OR (status='materializing' AND (result_json->>'materialization_lease_until')::timestamptz<now())) RETURNING *`,[pending.id]);
  const audit=claim.rows[0];if(!audit)continue;const p=audit.result_json;
  try{
   const b=(await db.query('SELECT * FROM source_goal_bindings WHERE id=$1',[audit.binding_id])).rows[0] as GoalBindingRow;if(!b)throw new Error('source_native_stale_result');
   const identity={spaceId:audit.space_id,userId:(await db.query('SELECT owner_user_id FROM source_goals WHERE id=$1',[goalId])).rows[0].owner_user_id};const g=await activeGoalIntent(db,await requireGoal(db,identity,goalId,true));
   if(g.status!=='running'||g.active_version_id!==audit.version_id||b.revision!==p.binding_revision||JSON.stringify(b.spec_json)!==JSON.stringify(p.spec))throw new Error('source_native_stale_result');
   if(b.lease_token!==p.materialization_token||!b.lease_until||Date.parse(String(b.lease_until))<=Date.now()){
    const token=randomUUID();const reclaimed=await db.query(`UPDATE source_goal_bindings SET lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1 AND revision=$3 AND status='collecting' AND (lease_token IS NULL OR lease_until<now()) RETURNING id`,[b.id,token,b.revision]);
    if(!reclaimed.rows.length){await db.query(`UPDATE source_goal_runs SET status='accepted' WHERE id=$1`,[audit.id]);continue;}
    p.materialization_token=token;await db.query(`UPDATE source_goal_runs SET result_json=result_json||$2::jsonb WHERE id=$1 AND status='materializing'`,[audit.id,{materialization_token:token}]);
   }
   await recoverGoalWatermark(db,g.id,b,p.materialization_token);p.cursor_before=b.cursor_json;
   const source=await preflightGoalSource(db,config,identity,g,b.spec_json);const policy=agentReadingPolicy(source);
   const prepared=CustomSourceHandlerOutputSchema.parse(p.accepted_output);
   const result:GoalExecutionResult={output:prepared,topicSignals:p.topic_signals??null,fixture:null,source_kind:'search',cursor:{coverage:'native_search_window',last_collected_at:new Date(audit.started_at).toISOString(),physical_requests:null},filesRoot:config.sandboxRoot,cleanup:async()=>{},envelope:{allowed_network_origins:[],capture_policy:policy.capture,retention_policy:policy.retention,credential_ref:null,limits:{timeout_ms:10000,max_download_bytes:1048576,max_output_bytes:1048576,max_items:g.budget_json.items_per_source,max_files:g.budget_json.items_per_source,max_evidence_items:100,log_max_bytes:1}}};
   const selected=await selectGoalResult(db,g,b.spec_json,p.cursor_before,result);const materialized=await materializeGoalBatch(db,config,g,b,p.materialization_token,audit.id,selected);
   await db.query(`UPDATE source_goal_runs SET result_json=result_json||$2::jsonb WHERE id=$1`,[audit.id,{goal_items_new:materialized.goal_items_new,items_observed:materialized.itemIds.length}]);
   // A reused preview already covered this window: the next check of this
   // binding waits one interval instead of immediately paying again.
   if(p.bootstrap_preview_id)await db.query(`UPDATE source_goal_bindings SET retry_at=now()+make_interval(secs=>$2::int) WHERE id=$1 AND status='active' AND retry_at IS NULL`,[b.id,g.budget_json.interval_seconds]);
   await db.query(`UPDATE source_goal_runs SET status='succeeded',ended_at=now() WHERE id=$1 AND status='materializing'`,[audit.id]);
  }catch(error){
   const refused=error instanceof HttpError&&[403,404,409].includes(error.statusCode)||error instanceof Error&&/^source_(native_|authority_|scope_|policy_)/.test(error.message);
   if(refused){const body=error instanceof HttpError?(error.responseBody as {error?:unknown}|undefined)?.error:undefined;const code=typeof body==='string'&&/^source_[a-z_]+$/.test(body)?body:error instanceof Error&&/^source_[a-z_]+$/.test(error.message)?error.message:error instanceof HttpError&&[403,404].includes(error.statusCode)?'source_authority_revoked':'source_native_stale_result';await db.query(`UPDATE source_goal_runs SET status='failed',result_json=result_json||$2::jsonb,ended_at=now() WHERE id=$1`,[audit.id,{error:code}]);await db.query(`UPDATE source_goal_bindings SET status='paused',retry_at=NULL,fixture_json=fixture_json||$2::jsonb WHERE id=$1 AND status='collecting' AND revision IS NOT DISTINCT FROM $3::int`,[audit.binding_id,{collection_error:code},p.binding_revision]);}
   else{await db.query(`UPDATE source_goal_runs SET status='accepted' WHERE id=$1 AND status='materializing'`,[audit.id]);throw error;}
  }finally{
   await db.query('UPDATE source_goal_bindings SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2',[audit.binding_id,p.materialization_token]);
  }
 }
 await db.query("UPDATE source_goals g SET status='paused',compatibility_json=compatibility_json-'manual_pending' WHERE g.id=$1 AND g.compatibility_json->>'manual_pending'='true' AND g.compatibility_json->>'execution_mode'='manual' AND NOT EXISTS(SELECT 1 FROM source_goal_runs r WHERE r.goal_id=g.id AND r.status IN ('accepted','materializing'))",[goalId]);

}
