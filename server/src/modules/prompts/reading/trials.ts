import {isDeepStrictEqual} from 'node:util';
import type {RuntimeSessionConfigSelection} from '@rainver/protocol';
import {resolveSessionConfig,sessionConfigRunOverride} from '../../sessions/sessionConfig.js';
import type {ReadingMethodTrialView,ReadingMethodTrialOutput} from '@rainver/protocol';
import {HttpError,withQueryableTransaction,withDbTransaction,type Pool,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import type {ServerConfig} from '../../../config.js';
import {PgRunRepository,type RunRecord} from '../../runs/repository.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
import {PgConversationBackendRepository} from '../../sessions/conversationBackendRepository.js';
import {closeReadingContext,assertClosedReadingContext} from './closedContext.js';
import {nativeProfileFingerprint} from '../../sources/goals/nativeRoute.js';
import {runFinalizationReconcilerRegistry} from '../../runs/finalizationReconcilerRegistry.js';
import {readingItemContext,assertReadingRunEgress} from '../../sources/index.js';
import {EvolvableAssetRepository} from '../../evolution/assetRepository.js';
import {EvolvableAssetEvaluationRepository} from '../../evolution/assetEvaluationRepository.js';
import {lockEvolutionAssets} from '../../evolution/assetLocks.js';
import {createManagedExecutionPolicy} from '../../policy/managedExecutionPolicy.js';
import {assertSampleAuthority,sampleContentChanged} from './sampleAuthority.js';
import {sha256Json} from '../hash.js';
import {resolvePrompt} from '../resolver.js';
import {freezeReadingMethod,readingMethodBlock,readingStrategy} from './runtime.js';
import {normalizeVersionScopeForWrite} from '../../evolution/assetAccess.js';
import {lockProjectAudience} from '../../projects/access.js';
import {readingAsset,readingCandidate} from './access.js';
import {ReadingMethodTrialSchema,ReadingMethodJudgeSchema} from '@rainver/protocol';

export const PAIR_EVALUATOR='reading_method_pair.v1';
interface PairRow extends Record<string,unknown> {id:string;status:string;candidate_version_id:string;baseline_version_id:string;metrics_json:{judgment?:string;reason?:string};eval_suite_ref_json:PairRef;}
interface PairRef {kind:typeof PAIR_EVALUATOR;item_id:string;project_id:string|null;authority:string;context_hash:string;case_id:string;case_hash:string;case_name:string;baseline_run_id:string;candidate_run_id:string;baseline_hash:string;candidate_hash:string;request_key:string;profile_hash:string;execution_name?:string;session_config?:RuntimeSessionConfigSelection[];}
export function trialContext(run:Pick<RunRecord,'contract_snapshot_json'>){return (run.contract_snapshot_json as {workflow_input_json?:{reading_method_trial?:{evaluation_id:string;side:'baseline'|'candidate';prompt_hash?:string}}})?.workflow_input_json?.reading_method_trial;}
const terminal=new Set(['succeeded','degraded','failed','cancelled','orphaned']);
/** Read the canonical reply channel, never a fabricated fixture or an evaluation's handwritten output. */
function readingTrialText(run:Pick<RunRecord,'output_json'>):string|null{
 const output=run.output_json as {summary?:unknown;result?:{output_text?:unknown}}|null;
 const text=typeof output?.result?.output_text==='string'?output.result.output_text:typeof output?.summary==='string'?output.summary:null;
 return text?.trim()?text:null;
}


/** Same prepared evidence, context and profile, two ordinary Runs; no material-submit/write capability. */
export async function startReadingTrial(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,raw:unknown){
 const parsed=ReadingMethodTrialSchema.safeParse(raw);if(!parsed.success)throw new HttpError(422,parsed.error.message);const input=parsed.data;
 return withDbTransaction(db,async tx=>{
  // Same order as promotion/bundle apply: asset first, then Project audience.
  const asset=await readingAsset(tx,identity);await lockEvolutionAssets(tx,[asset.id]);
  let ctx=await readingItemContext(tx,identity,input.item_id,input.project_id);
  if(ctx.projectId){await lockProjectAudience(tx,identity.spaceId,ctx.projectId);ctx=await readingItemContext(tx,identity,input.item_id,input.project_id);}
  const {version}=await readingCandidate(tx,identity,input.candidate_version_id,ctx.projectId);
  // Serialize the candidate content/transition with edits and concurrent starts.
  const candidate=(await tx.query(`SELECT * FROM evolvable_asset_versions WHERE id=$1 AND asset_id=$2 FOR UPDATE`,[version.id,asset.id])).rows[0];
  if(candidate.content_hash!==input.candidate_content_hash)throw new HttpError(409,'Candidate changed; reload before starting a paid comparison');
  const method=readingStrategy(candidate.content_json);if(!method || method.length>12000)throw new HttpError(422,'Candidate must contain a bounded text method');
  const sample=(await tx.query(`SELECT * FROM evaluation_cases WHERE id=$1 AND asset_id=$2 AND space_id=$3 AND status='active'`,[input.case_id,asset.id,identity.spaceId])).rows[0];
  if(!sample || sample.input_json?.kind!=='reading_method_sample.v1' || sample.created_by_user_id!==identity.userId || sample.input_json?.reading_item_id!==ctx.item.id || sample.input_json?.project_id!==ctx.projectId)throw new HttpError(404,'Reading sample not found');
  if(sample.input_json.authority!==ctx.authority || sample.input_json.context_hash!==sha256Json(ctx.context))throw new HttpError(409,'Sample material or context changed; save a fresh sample');
  await assertSampleAuthority(tx,identity,ctx,sample.input_json);
  await tx.query(`SELECT id FROM agents WHERE id=$1 AND space_id=$2 FOR SHARE`,[input.agent_id,identity.spaceId]);
  await tx.query(`SELECT id FROM agent_runtime_profiles WHERE id=$1 AND space_id=$2 AND agent_id=$3 FOR SHARE`,[input.runtime_profile_id,identity.spaceId,input.agent_id]);
  const backend=(await new PgConversationBackendRepository(tx).listOptions(identity.spaceId,identity.userId,input.agent_id)).find(p=>p.runtime_profile_id===input.runtime_profile_id&&p.usable!==false);if(!backend)throw new HttpError(409,'Choose a usable Agent runtime');
  if(!(await tx.query(`SELECT id FROM agents WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND status='active'`,[input.agent_id,identity.spaceId,identity.userId])).rows.length)throw new HttpError(403,'Use your own active Agent');
  const baseline=await freezeReadingMethod(tx,{...identity,projectId:ctx.projectId,agentId:input.agent_id},ctx.context);
  const session=await resolveSessionConfig([],async()=>[],backend.session_config_options??[]);
  const profileHash=await nativeProfileFingerprint(tx,input.runtime_profile_id);
  if(input.retry_of){const prior=await authorizedPair(tx,identity,input.retry_of);if(prior.ref.item_id!==ctx.item.id||prior.row.candidate_version_id!==candidate.id||!['failed','blocked','cancelled'].includes(prior.row.status))throw new HttpError(409,'Only a failed/cancelled comparison of this candidate may be retried');}
  const key=sha256Json([identity.userId,ctx.item.id,ctx.projectId,ctx.authority,baseline.frozen.version_id,candidate.id,candidate.content_hash,input.case_id,sample.input_json,input.agent_id,input.runtime_profile_id,profileHash,session.selections,input.retry_of??null]);
  const prior=(await tx.query(`SELECT id FROM evolvable_asset_evaluation_runs WHERE asset_id=$1 AND space_id=$2 AND evaluator_version=$3 AND eval_suite_ref_json->>'request_key'=$4 ORDER BY created_at DESC LIMIT 1`,[asset.id,identity.spaceId,PAIR_EVALUATOR,key])).rows[0];if(prior)return readReadingTrial(tx,identity,prior.id);
  const inflight=(await tx.query(`SELECT count(*)::int n FROM evolvable_asset_evaluation_runs WHERE space_id=$1 AND created_by_user_id=$2 AND evaluator_version=$3 AND status IN ('queued','running')`,[identity.spaceId,identity.userId,PAIR_EVALUATOR])).rows[0].n;
  if(inflight>=1)throw new HttpError(409,'A reading comparison is already running');
  if((await tx.query(`SELECT count(*)::int n FROM evolvable_asset_evaluation_runs WHERE space_id=$1 AND created_by_user_id=$2 AND evaluator_version=$3 AND created_at>now()-interval '1 day'`,[identity.spaceId,identity.userId,PAIR_EVALUATOR])).rows[0].n>=3)throw new HttpError(429,'At most three reading comparisons per day');
  if(candidate.status==='draft')await new EvolvableAssetRepository(tx).transitionVersionStatus(identity,asset.id,candidate.id,{status:'candidate'});
  const evaluation=await new EvolvableAssetEvaluationRepository(tx).recordEvaluationRun(identity,asset.id,candidate.id,{baseline_version_id:baseline.frozen.version_id,eval_suite_ref:{kind:PAIR_EVALUATOR},evaluator_version:PAIR_EVALUATOR,status:'queued'},{trustedExecutor:true});
  const jobs=new PgJobQueueRepository(tx);const runs:RunRecord[]=[];
  for(const side of ['baseline','candidate'] as const){
   const strategy=side==='baseline'?baseline.text:method;
   const prompt=readingMethodBlock(strategy,ctx.context)+`\nOFFLINE CONTROLLED COMPARISON. Read only the following supplied page bundle. It contains a homepage and linked documentation/examples. No live fetch or tools are granted. Cite only URLs actually supported by these pages; identify inaccessible/missing evidence. The two sides use exactly the same material/context/profile. Produce a readable Markdown investigation with capability → mechanism → evidence → project fit → adaptation cost → unknowns.\n<untrusted_evidence>${JSON.stringify(sample.input_json.pages)}</untrusted_evidence>`;
   if(prompt.length>48000)throw new HttpError(422,'Trial input exceeds 48000 characters');
   const run=await new PgRunRepository(tx).createQueuedRunWithBudgetAdmission({execution_kind:'agent',space_id:identity.spaceId,user_id:identity.userId,agent_id:input.agent_id,runtime_profile_id:input.runtime_profile_id,project_id:null,model_override_json:sessionConfigRunOverride(session),mode:'live',run_type:'agent',trigger_origin:'manual',visibility:'private',capabilities_json:[],scenario_tool_allowance:[],prompt,instruction:'Use only the supplied evidence. Do not browse, use tools, change files or write to Rainver. A structural result is not a quality judgment.',contract_snapshot:{source:{kind:'direct',id:ctx.item.id},workflow_input_json:{reading_method_trial:{evaluation_id:evaluation.id,side,prompt_hash:sha256Json(prompt)}},policy_context_json:createManagedExecutionPolicy('reading_method_trial',false),max_attempts:1,max_duration_seconds:180,risk_level:'low'}});
   runs.push(run);await closeReadingContext(tx,identity,run.id,input.agent_id,input.runtime_profile_id,ctx.projectId);
   if(ctx.source)await (await import('../../sources/sourcePromptEgress.js')).assertSourcePromptEgressAllowed(tx,ctx.source,input.agent_id,input.runtime_profile_id);
   await jobs.enqueue({job_type:'agent_run',space_id:identity.spaceId,user_id:identity.userId,agent_id:input.agent_id,payload:{run_id:run.id},max_attempts:1});
  }
  const ref:PairRef={kind:PAIR_EVALUATOR,item_id:ctx.item.id,project_id:ctx.projectId,authority:ctx.authority,context_hash:sha256Json(ctx.context),case_id:sample.id,case_hash:sha256Json(sample.input_json),case_name:sample.name,baseline_run_id:runs[0]!.id,candidate_run_id:runs[1]!.id,baseline_hash:baseline.frozen.content_hash!,candidate_hash:candidate.content_hash,request_key:key,profile_hash:profileHash,execution_name:backend.name,session_config:session.selections};
  await tx.query(`UPDATE evolvable_asset_evaluation_runs SET eval_suite_ref_json=$2::jsonb,run_id=$3 WHERE id=$1`,[evaluation.id,JSON.stringify(ref),runs[1]!.id]);
  return readReadingTrial(tx,identity,String(evaluation.id));
 });
}

async function authorizedPair(db:Queryable,identity:SpaceUserIdentity,id:string){
 const asset=await readingAsset(db,identity);const row=(await db.query<PairRow>(`SELECT * FROM evolvable_asset_evaluation_runs WHERE id=$1 AND asset_id=$2 AND space_id=$3 AND created_by_user_id=$4 AND evaluator_version=$5`,[id,asset.id,identity.spaceId,identity.userId,PAIR_EVALUATOR])).rows[0];if(!row)throw new HttpError(404,'Comparison not found');
 return {row,ref:row.eval_suite_ref_json as PairRef};
}
export async function assertReadingTrialRun(db:Queryable,run:RunRecord){
 const trial=trialContext(run);if(!trial)return;
 const identity={spaceId:run.space_id,userId:run.instructed_by_user_id!};const {row,ref}=await authorizedPair(db,identity,trial.evaluation_id);
 if(!['queued','running'].includes(row.status) || (trial.side==='baseline'?ref.baseline_run_id:ref.candidate_run_id)!==run.id)throw new HttpError(409,'Comparison is no longer running');
 await assertReadingTrialReadable(db,run);
 const fresh=await readingItemContext(db,identity,ref.item_id,ref.project_id);const freshCase=(await db.query('SELECT input_json FROM evaluation_cases WHERE id=$1',[ref.case_id])).rows[0];await assertSampleAuthority(db,identity,fresh,freshCase?.input_json);if(fresh.authority!==ref.authority||sha256Json(fresh.context)!==ref.context_hash)throw new HttpError(409,'Trial input is stale');
 await normalizeVersionScopeForWrite(db,identity,ref.project_id?'project':'space',ref.project_id??run.space_id);
 if(!(await db.query(`SELECT id FROM agents WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND status='active'`,[run.agent_id,run.space_id,identity.userId])).rows.length)throw new HttpError(403,'Trial Agent authority changed');
 if(trial.prompt_hash!==sha256Json(run.prompt))throw new HttpError(409,'Trial request changed');
 await assertClosedReadingContext(db,run.space_id,run.id,ref.project_id);
 if(ref.profile_hash!==await nativeProfileFingerprint(db,run.requested_runtime_profile_id!))throw new HttpError(409,'Trial execution configuration changed');
 const option=(await new PgConversationBackendRepository(db).listOptions(run.space_id,identity.userId,run.agent_id!)).find(p=>p.runtime_profile_id===run.requested_runtime_profile_id&&p.usable!==false);if(!option)throw new HttpError(409,'Trial runtime unavailable');
 const selections=(await resolveSessionConfig(ref.session_config??[],async()=>[],option.session_config_options??[])).selections;
 if(!isDeepStrictEqual(selections,ref.session_config??[])||!isDeepStrictEqual((run.model_override_json as {acp_session_config?:unknown}|null)?.acp_session_config??[],ref.session_config??[]))throw new HttpError(409,'Trial model/mode configuration changed');
}
export async function assertReadingTrialReadable(db:Queryable,run:RunRecord){
 const trial=trialContext(run);if(!trial)return;
 const identity={spaceId:run.space_id,userId:run.instructed_by_user_id!};const {row,ref}=await authorizedPair(db,identity,trial.evaluation_id);
 const versions=(await db.query<{id:string;content_hash:string}>(`SELECT id,content_hash,version FROM evolvable_asset_versions WHERE id=ANY($1::varchar[])`,[[row.baseline_version_id,row.candidate_version_id]])).rows;
 if(versions.find(v=>v.id===row.baseline_version_id)?.content_hash!==ref.baseline_hash||versions.find(v=>v.id===row.candidate_version_id)?.content_hash!==ref.candidate_hash)throw new HttpError(409,'Comparison versions changed');
 const ctx=await readingItemContext(db,identity,ref.item_id,ref.project_id);
 for(const parent of (await (await import('./dispatch.js')).readingDependencyRuns(db,run)).slice(1)){const root=await (await import('./generationAuthority.js')).assertGenerationReadable(db,identity,parent);await assertReadingRunEgress(db,run,root.source?.id??null);}

 const sample=(await db.query(`SELECT input_json FROM evaluation_cases WHERE id=$1 AND space_id=$2 AND status='active'`,[ref.case_id,identity.spaceId])).rows[0];if(!sample||sha256Json(sample.input_json)!==ref.case_hash)throw new HttpError(409,'Sample changed');
 await assertSampleAuthority(db,identity,ctx,sample.input_json,false);
 await assertReadingRunEgress(db,run,ctx.source?.id??null);
}
export async function readReadingTrial(db:Queryable,identity:SpaceUserIdentity,id:string):Promise<ReadingMethodTrialView>{
 const {row,ref}=await authorizedPair(db,identity,id);
 const base={id:row.id,status:row.status,candidate_version_id:row.candidate_version_id,baseline_version_id:row.baseline_version_id,stale:false,visibility:'visible' as const,baseline:null,candidate:null,judgment:row.metrics_json?.judgment??null,reason:row.metrics_json?.reason??null,case_name:ref.case_name,execution_name:ref.execution_name};
 let effectiveBaseline:string|null=null;let inputStale=false;
 try {const ctx=await readingItemContext(db,identity,ref.item_id,ref.project_id);effectiveBaseline=(await resolvePrompt(db,{...identity,assetKey:'reading.project_investigation',projectId:ctx.projectId})).version_id;for(const runId of [ref.baseline_run_id,ref.candidate_run_id]){const r=await new PgRunRepository(db).getRun(identity.spaceId,runId);if(!r)throw new HttpError(404,'Trial Run missing');await assertReadingTrialReadable(db,r);await assertReadingRunEgress(db,r,ctx.source?.id??null);}inputStale=ctx.authority!==ref.authority||sha256Json(ctx.context)!==ref.context_hash;const sample=(await db.query(`SELECT input_json FROM evaluation_cases WHERE id=$1 AND space_id=$2 AND status='active'`,[ref.case_id,identity.spaceId])).rows[0];if(!sample||sha256Json(sample.input_json)!==ref.case_hash)throw new HttpError(409,'Changed sample');await assertSampleAuthority(db,identity,ctx,sample.input_json,false);inputStale ||= await sampleContentChanged(db,identity.spaceId,sample.input_json);}
 catch(error){if(!(error instanceof HttpError)||![403,404,409].includes(error.statusCode))throw error;return {...base,visibility:'withheld',judgment:null,reason:null,case_name:'',execution_name:undefined};}
 const versions=(await db.query(`SELECT id,content_hash,version FROM evolvable_asset_versions WHERE id=ANY($1::varchar[])`,[[row.candidate_version_id,row.baseline_version_id]])).rows;
 const stale=inputStale||versions.find(v=>v.id===row.candidate_version_id)?.content_hash!==ref.candidate_hash||versions.find(v=>v.id===row.baseline_version_id)?.content_hash!==ref.baseline_hash||effectiveBaseline!==row.baseline_version_id;
 const output=async(runId:string):Promise<ReadingMethodTrialOutput>=>{const run=await new PgRunRepository(db).getVisibleRun(identity.spaceId,identity.userId,runId);if(!run)return {run_id:runId,status:'unavailable',text:null,seconds:null,cost_usd:null};const cost=(await db.query<{cost:number|null}>(`SELECT CASE WHEN count(*)=0 OR count(*) FILTER (WHERE estimated_cost_usd IS NULL)>0 THEN NULL ELSE sum(estimated_cost_usd)::float END AS cost FROM token_usage_events WHERE run_id=$1 AND space_id=$2`,[runId,identity.spaceId])).rows[0]?.cost??null;return {run_id:run.id,status:run.status,text:terminal.has(run.status)?readingTrialText(run):null,seconds:run.started_at&&run.ended_at?(Date.parse(run.ended_at)-Date.parse(run.started_at))/1000:null,cost_usd:cost};};
 return {...base,stale,baseline_version:Number(versions.find(v=>v.id===row.baseline_version_id)?.version),candidate_version:Number(versions.find(v=>v.id===row.candidate_version_id)?.version),baseline:await output(ref.baseline_run_id),candidate:await output(ref.candidate_run_id)};
}
export async function judgeReadingTrial(db:Pool,identity:SpaceUserIdentity,id:string,raw:unknown){
 const parsed=ReadingMethodJudgeSchema.safeParse(raw);if(!parsed.success)throw new HttpError(422,parsed.error.message);
 return withDbTransaction(db,async tx=>{const asset=await readingAsset(tx,identity);await lockEvolutionAssets(tx,[asset.id]);await tx.query('SELECT id FROM evolvable_asset_evaluation_runs WHERE id=$1 FOR UPDATE',[id]);const view=await readReadingTrial(tx,identity,id);if(view.visibility!=='visible'||view.stale||view.status!=='passed'||view.baseline?.status!=='succeeded'||view.candidate?.status!=='succeeded')throw new HttpError(409,'Only a completed, current, authorized comparison can be judged');await tx.query(`UPDATE evolvable_asset_evaluation_runs SET metrics_json=metrics_json||$2::jsonb,updated_at=now() WHERE id=$1`,[id,JSON.stringify(parsed.data)]);return readReadingTrial(tx,identity,id);});
}
export async function cancelReadingTrial(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,id:string){
 // Stopping one's own paid work does not require retaining access to its withdrawn input.
 const row=(await db.query<PairRow>(`SELECT * FROM evolvable_asset_evaluation_runs WHERE id=$1 AND space_id=$2 AND created_by_user_id=$3 AND evaluator_version=$4`,[id,identity.spaceId,identity.userId,PAIR_EVALUATOR])).rows[0];
 if(!row)throw new HttpError(404,'Comparison not found');const ref=row.eval_suite_ref_json;
 const {buildRunOrchestration}=await import('../../runs/orchestrationFactory.js');
 for(const runId of [ref.baseline_run_id,ref.candidate_run_id]){
  const run=await new PgRunRepository(db).getRun(identity.spaceId,runId);
  if(run&&run.instructed_by_user_id===identity.userId&&trialContext(run)?.evaluation_id===id&&(!terminal.has(run.status)||run.status==='cancelled'))await buildRunOrchestration(config).orchestration.cancelRun({space_id:identity.spaceId,run_id:run.id,requested_by_user_id:identity.userId});
 }
 try{return await readReadingTrial(db,identity,id)}catch(error){
  if(!(error instanceof HttpError)||![403,404,409].includes(error.statusCode))throw error;
  const state=(await db.query<{status:string}>(`SELECT status FROM evolvable_asset_evaluation_runs WHERE id=$1 AND space_id=$2`,[id,identity.spaceId])).rows[0];
  return {id,status:state?.status??'unavailable',visibility:'withheld',baseline:null,candidate:null,judgment:null,reason:null,case_name:'',stale:true,candidate_version_id:row.candidate_version_id,baseline_version_id:row.baseline_version_id};
 }
}

export function registerReadingTrialSettlement(){runFinalizationReconcilerRegistry.register('reading_method_pair', {async reconcile(pool,run){return withQueryableTransaction(pool,async db=>{
 const trial=trialContext(run);if(!trial)return;
 const row=(await db.query<PairRow>(`SELECT * FROM evolvable_asset_evaluation_runs WHERE id=$1 AND space_id=$2 AND evaluator_version=$3 FOR UPDATE`,[trial.evaluation_id,run.space_id,PAIR_EVALUATOR])).rows[0];if(!row||!['queued','running'].includes(row.status))return;
 const ref=row.eval_suite_ref_json as PairRef;if(![ref.baseline_run_id,ref.candidate_run_id].includes(run.id))return;
 const states=(await db.query<{status:string;output_json:unknown}>(`SELECT status,output_json FROM runs WHERE space_id=$1 AND id=ANY($2::varchar[])`,[run.space_id,[ref.baseline_run_id,ref.candidate_run_id]])).rows;
 if(states.length!==2||states.some(r=>!terminal.has(r.status)))return;
 let status=states.some(r=>r.status==='cancelled')?'cancelled':states.every(r=>r.status==='succeeded'&&!!readingTrialText(r))?'passed':'failed';
 try {await assertReadingTrialRun(db,run);}catch(error){if(!(error instanceof HttpError))throw error;if(status!=='cancelled')status='blocked';}
 await db.query(`UPDATE evolvable_asset_evaluation_runs SET status=$2,metrics_json=metrics_json||'{"structure_only":true}'::jsonb,updated_at=now() WHERE id=$1 AND status IN ('queued','running')`,[row.id,status]);
 });}},'prompts');}
