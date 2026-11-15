import type {ProviderTaskAttemptRefs} from '../providers/commands/types.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import * as protocol from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {dbPool,HttpError,withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {canonical} from '../systemActions/operations/repository.js';
import {withRunTerminalOwner} from '../systemActions/operations/proposalTransitions.js';
import {JobEffectLeaseLost,lockCurrentJobClaim,withJobEffectAuthority} from '../jobs/effectAuthority.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {PgRunRepository} from '../runs/repository.js';
import {canonicalRunOutput} from '../runs/orchestrationResults.js';
import {failBoundedProviderTaskRun} from '../runs/boundedProviderTaskRun.js';
import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import {admitStrategy,strategyPerson} from './discovery/strategyAdmission.js';
import {ResearchContextRepository} from '../projectResearch/question/researchContextRepository.js';
import {ResearchQueryRepository} from './queryPlanning/repository.js';
import {AdaptiveQueryOrchestrator,type AdaptiveResearchQueryDependencies} from './queryPlanning/adaptiveQueryOrchestrator.js';
import {evaluationWrites} from './queryPlanning/evaluationWrites.js';

export const RESEARCH_EVALUATION_JOB='research_query_evaluation';
const InputSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('evaluate'),request:protocol.EvaluateResearchQueryStrategyRequestSchema}).strict(),
 z.object({kind:z.literal('retry'),provider_key:protocol.ResearchProviderKeySchema,request:protocol.RetryResearchQueryProviderRequestSchema}).strict(),
]);
export type ResearchEvaluationInput=z.infer<typeof InputSchema>;
const IntentSchema=z.object({version:z.literal(1),strategy_id:z.string().uuid(),actor:protocol.OperationActorSchema,input:InputSchema,model_task:z.boolean(),state_hash:z.string().length(64)}).strict();
type Intent=z.infer<typeof IntentSchema>;
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const conflict=(message:string)=>new HttpError(409,message);

async function currentState(db:Queryable,config:ServerConfig,intent:Pick<Intent,'actor'|'strategy_id'|'input'>){
 const {actor,input,strategy_id}=intent,person=strategyPerson(actor);
 if(actor.principal.kind!=='user'||!person.userId||actor.principal.id!==person.userId||actor.agent_id||actor.run_id)throw new HttpError(404,'Research evaluation intent unavailable');
 const closure=await admitStrategy(db,config,actor,strategy_id,[],Object.values(input.request.credentials??{}));
 const strategy=await new ResearchQueryRepository(db).getStrategy(actor.space_id,input.request.project_id,strategy_id);
 if(!strategy||strategy.project_id!==closure.strategy.project_id)throw new HttpError(404,'Research evaluation strategy unavailable');
 const contexts=[];
 for(const c of closure.contexts){
  const context=await new ResearchContextRepository(db).get(actor.space_id,c.project_id,c.id);
  if(!context)throw new HttpError(404,'Research evaluation context unavailable');
  contexts.push({id:context.id,project_id:context.project_id,version:context.version,context:context.context,assessment:context.assessment,provenance:context.provenance});
 }
 // Pin the actual Source consent/egress version in the durable intent, not
 // merely its ids. The canonical owner has locked and reauthorized these rows.
 const sources=(await db.query('SELECT id,status,owner_user_id,consent_json,policy_json,updated_at::text AS updated_at FROM source_connections WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id',[actor.space_id,closure.parents.map(p=>p.id)])).rows;
 return {strategy,contexts,sources};
}

/** Business replay is independent of transport keys and newly allocated strategy ids. */
export async function existingEvaluation(db:Queryable,config:ServerConfig,actor:protocol.OperationActor,request:protocol.EvaluateResearchQueryStrategyRequest){
 const jobs=(await db.query<{id:string;status:string;payload_json:Record<string,unknown>}>(`SELECT j.id,j.status,j.payload_json FROM jobs j JOIN research_query_strategies s ON s.id=j.payload_json->'intent'->>'strategy_id' AND s.space_id=j.space_id WHERE j.space_id=$1 AND j.user_id=$2 AND j.job_type=$3 AND s.research_context_version_id=$4 AND j.payload_json->'intent'->'input'->>'kind'='evaluate' ORDER BY j.created_at DESC,j.id DESC`,[actor.space_id,actor.on_behalf_of_user_id,RESEARCH_EVALUATION_JOB,request.research_context_version_id])).rows;
 for(const job of jobs){
  const intent=IntentSchema.parse(job.payload_json.intent);
  if(canonical(intent.input)!==canonical({kind:'evaluate',request})||!['pending','claimed','running','completed'].includes(job.status))continue;
  const state=await currentState(db,config,intent);
  if(job.status!=='completed'&&hash(state)!==intent.state_hash)throw conflict('Research evaluation authority or version changed');
  if(hash(intent)!==job.payload_json.intent_hash)throw conflict('Research evaluation intent changed');
  await auditRunJob(db,config,{actor,strategy_id:intent.strategy_id});
  return protocol.ResearchQueryEvaluationAcceptedJobSchema.parse({job_id:job.id,run_id:job.payload_json.run_id,strategy_id:intent.strategy_id,status:job.status==='completed'?'succeeded':job.status==='running'?'running':'queued'});
 }
 return null;
}

/** Joins the canonical operation transaction. The caller creates a fresh
 * planning strategy in that SAME transaction for evaluate; retry uses its
 * existing strategy. No provider I/O occurs at admission. */
export async function requestRunJob(db:Queryable,config:ServerConfig,actor:protocol.OperationActor,strategyId:string,raw:ResearchEvaluationInput){
 const input=InputSchema.parse(raw),base={actor:protocol.OperationActorSchema.parse(actor),strategy_id:strategyId,input};
 // Nonwaiting intent admission precedes domain/Job/Run row locks.
 const context=(await db.query<{research_context_version_id:string}>('SELECT research_context_version_id FROM research_query_strategies WHERE space_id=$1 AND id=$2',[actor.space_id,strategyId])).rows[0];
 if(!context)throw new HttpError(404,'Research evaluation strategy unavailable');
 const key=`research-evaluation:${actor.space_id}:${actor.on_behalf_of_user_id}:${context.research_context_version_id}`;
 const held=await db.query<{held:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held',[key]);
 if(!held.rows[0]?.held)throw conflict('Research evaluation intent is busy');
 const state=await currentState(db,config,base);
 if(input.kind==='evaluate'){
  if(state.strategy.status!=='planning'||state.strategy.research_context_version_id!==input.request.research_context_version_id||canonical(state.strategy.provider_plans.map(p=>p.provider_key).sort())!==canonical([...new Set(input.request.providers)].sort())||state.strategy.execution_budget.candidate_budget!==input.request.candidate_budget)throw conflict('Research evaluation strategy changed');
 }else{
  const plan=state.strategy.provider_plans.find(p=>p.provider_key===input.provider_key);
  if(state.strategy.materialized_at!==null||!plan||!['unavailable','selected'].includes(plan.status))throw conflict('Research provider plan cannot be retried');
 }
 await auditRunJob(db,config,base);
 const intent:Intent={version:1,...base,model_task:Boolean(input.request.execution?.model_provider_id&&!state.strategy.semantic_intent),state_hash:hash(state)};
 const prior=(await db.query<{id:string;status:string;payload_json:Record<string,unknown>;result_json:Record<string,unknown>|null}>(`SELECT j.id,j.status,j.payload_json,j.result_json FROM jobs j JOIN research_query_strategies s ON s.id=j.payload_json->'intent'->>'strategy_id' AND s.space_id=j.space_id WHERE j.space_id=$1 AND j.job_type=$2 AND s.research_context_version_id=$3 AND j.user_id=$4 AND ((j.payload_json->'intent'->'input'->>'kind'=$5 AND COALESCE(j.payload_json->'intent'->'input'->>'provider_key','')=$6) OR j.status IN ('pending','claimed','running') OR (j.status IN ('failed','cancelled') AND j.result_json->>'effect_started'='true')) ORDER BY j.created_at DESC,j.id DESC LIMIT 1`,[actor.space_id,RESEARCH_EVALUATION_JOB,context.research_context_version_id,actor.on_behalf_of_user_id,input.kind,input.kind==='retry'?input.provider_key:''])).rows[0];
 if(prior&&!(prior.status==='completed'&&String((prior.payload_json.intent as {strategy_id?:string}).strategy_id)!==strategyId)){
  const old=IntentSchema.parse(prior.payload_json.intent);
  if(old.strategy_id!==strategyId){
   const result=prior.result_json??{};
   if(!['failed','cancelled'].includes(prior.status)||result.research_evaluation_retry_safe!==true||result.effect_started===true)throw conflict('Research context already has evaluation work; do not resend under another strategy');
  }
  if(old.actor.on_behalf_of_user_id!==actor.on_behalf_of_user_id||canonical(old.input)!==canonical(input))throw conflict('Research evaluation has another intent');
  if(['pending','claimed','running'].includes(prior.status)){
   if(old.state_hash!==intent.state_hash)throw conflict('Research evaluation authority or version changed');
   return protocol.ResearchQueryEvaluationAcceptedJobSchema.parse({job_id:prior.id,run_id:typeof prior.payload_json.run_id==='string'?prior.payload_json.run_id:null,strategy_id:strategyId,status:prior.status==='running'?'running':'queued'});
  }
  const result=prior.result_json??{};
  // A new request key never authorizes replay of an unknown external send.
  if(!['failed','cancelled'].includes(prior.status)||result.research_evaluation_retry_safe!==true||result.effect_started===true)throw conflict('Research evaluation outcome is unknown or already completed; do not resend');
 }
 const run=intent.model_task?await new PgRunRepository(db).createQueuedProviderTaskRun({space_id:actor.space_id,user_id:actor.on_behalf_of_user_id!,project_id:state.strategy.project_id,task:'research_query_evaluation',run_type:'planning',trigger_origin:actor.effective_origin,visibility:'private',prompt:'Evaluate research provider query strategy',contract_snapshot:{source:{kind:'direct',id:strategyId},route_hints_json:{owner_domain:'research',strategy_id:strategyId}}}):null;
 const job=await new PgJobQueueRepository(db).enqueue({job_type:RESEARCH_EVALUATION_JOB,space_id:actor.space_id,user_id:actor.on_behalf_of_user_id!,max_attempts:1,payload:{intent,run_id:run?.id??null,intent_hash:hash(intent)}});
 return protocol.ResearchQueryEvaluationAcceptedJobSchema.parse({job_id:job.id,run_id:run?.id??null,strategy_id:strategyId,status:'queued'});
}

/** One handler for evaluate and explicit provider retry. Reuses the adaptive
 * orchestrator; only its repository writes wait for atomic settlement.
 * Registered with the canonical worker after formal operation admission. */
export function registerResearchEvaluationJob(registry:JobHandlerRegistry,config:ServerConfig,dependencies:Omit<AdaptiveResearchQueryDependencies,'repository'|'singleAttempt'|'contextRepository'>={}){
 if(!config.databaseUrl)return;
 registry.register(RESEARCH_EVALUATION_JOB,async job=>{
  const db=dbPool(config),stored=await new PgJobQueueRepository(db).getJob(job.job_id);
  if(!stored||stored.space_id!==job.space_id||stored.user_id!==job.user_id||stored.job_type!==RESEARCH_EVALUATION_JOB||stored.max_attempts!==1||job.max_attempts!==1)throw new JobEffectLeaseLost();
  const intent=IntentSchema.parse(stored.payload_json.intent),runId=stored.payload_json.run_id;
  if((runId!==null&&typeof runId!=='string')||Boolean(runId)!==intent.model_task||intent.actor.space_id!==job.space_id||intent.actor.on_behalf_of_user_id!==job.user_id||hash(intent)!==stored.payload_json.intent_hash)throw new JobEffectLeaseLost();
  let attempt:ProviderTaskAttemptRefs|undefined;
  const gate=async(tx:Queryable)=>{
   const state=await currentState(tx,config,intent);
   if(hash(state)!==intent.state_hash)throw conflict('Research evaluation context or strategy changed');
   await lockCurrentJobClaim(tx,job);
   const current=await new PgJobQueueRepository(tx).getJob(job.job_id);
   const run=runId?(await tx.query<{status:string;owner_user_id:string;execution_kind:string;project_id:string;provider_task_control_id:string|null;provider_task_delivery_id:string|null;provider_task_snapshot_id:string|null;model_provider_id:string|null}>('SELECT status,owner_user_id,execution_kind,project_id,provider_task_control_id,provider_task_delivery_id,provider_task_snapshot_id,model_provider_id FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE',[job.space_id,runId])).rows[0]:null;
   if(!current||hash(current.payload_json.intent)!==stored.payload_json.intent_hash||current.payload_json.run_id!==runId||(runId&&(!run||run.owner_user_id!==job.user_id||run.execution_kind!=='provider_task'||run.project_id!==intent.input.request.project_id||!['queued','running'].includes(run.status))))throw new JobEffectLeaseLost();
   if(attempt&&run?.status==='running'&&(run.provider_task_control_id!==attempt.control_id||run.provider_task_delivery_id!==attempt.delivery_id||run.provider_task_snapshot_id!==attempt.invocation_snapshot_id||run.model_provider_id!==attempt.provider_id))throw new JobEffectLeaseLost('Research provider attempt changed');
   return state;
  };
  const audit=async(tx:Queryable)=>auditRunJob(tx,config,intent);
  const settle=<T>(work:(tx:Queryable)=>Promise<T>)=>runId?withRunTerminalOwner(db,async()=>[{space_id:job.space_id,id:runId}],work):withQueryableTransaction(db,work);
  try{
   const prepared=await withQueryableTransaction(db,async tx=>{
    const state=await gate(tx);await audit(tx);
    const changed=await tx.query(`UPDATE jobs SET result_json='{"source_dispatch":"started"}'::jsonb WHERE id=$1 AND result_json IS NULL RETURNING id`,[job.job_id]);
    if(!changed.rows.length)throw conflict('Research evaluation outcome unknown; do not resend');
    const round=(await tx.query<{next_round:number}>(`SELECT COALESCE(MAX(a.round),-1)+1 AS next_round FROM research_query_attempts a JOIN research_query_provider_plans p ON p.id=a.provider_plan_id AND p.space_id=a.space_id WHERE a.space_id=$1 AND p.strategy_id=$2 AND p.provider_key=$3`,[job.space_id,intent.strategy_id,intent.input.kind==='retry'?intent.input.provider_key:''])).rows[0];
    return {state,nextRound:Number(round?.next_round??0)};
   });
   const journal=evaluationWrites(prepared.state.strategy,prepared.nextRound);
   const selected=intent.input.request.execution;
   const execution=selected?.model_provider_id&&runId?{
    modelProviderId:selected.model_provider_id,modelName:selected.model_name,
    spend:{kind:'person' as const,user_id:job.user_id!},singleAttempt:true as const,
    queuedTask:{runId,projectId:intent.input.request.project_id,authorizeAttempt:async(tx:Queryable,refs:ProviderTaskAttemptRefs)=>{
     if(attempt)throw new JobEffectLeaseLost('Research intent already attempted; do not resend');
     attempt=refs;await gate(tx);await audit(tx);
    }},
   }:undefined;
   await withJobEffectAuthority(db,job,async()=>{
    const orchestrator=new AdaptiveQueryOrchestrator(db,config,{...dependencies,repository:journal.store,singleAttempt:true});
    const person=strategyPerson(intent.actor),input=intent.input;
    if(input.kind==='evaluate')await orchestrator.evaluate(person,{projectId:input.request.project_id,researchContextVersionId:input.request.research_context_version_id,providers:input.request.providers,candidateBudget:input.request.candidate_budget,credentials:input.request.credentials,execution});
    else await orchestrator.retryProvider(person,{projectId:input.request.project_id,strategyId:intent.strategy_id,providerKey:input.provider_key,credentials:input.request.credentials,execution});
   },async effectDb=>{
    const admit=async(tx:Queryable)=>{await gate(tx);await audit(tx);await tx.query(`UPDATE jobs SET result_json=result_json||'{"effect_started":true}'::jsonb WHERE id=$1`,[job.job_id]);};
    if(effectDb)await admit(effectDb);else await withQueryableTransaction(db,admit);
   });
   return await settle(async tx=>{
    await gate(tx);await audit(tx);await journal.flush(tx);
    const strategy=await new ResearchQueryRepository(tx).getStrategy(job.space_id,intent.input.request.project_id,intent.strategy_id);
    const result=protocol.EvaluateResearchQueryStrategyResponseSchema.parse({strategy});
    if(runId)await new PgRunRepository(tx).markRunTerminal({space_id:job.space_id,run_id:runId,status:'succeeded',output_json:canonicalRunOutput({success:true,outputText:'Research query evaluation completed',outputJson:{strategy_id:intent.strategy_id,job_id:job.job_id}}),completed_at:new Date().toISOString()});
    await lockCurrentJobClaim(tx,job);
    if(!await new PgJobQueueRepository(tx).completeJob(job.job_id,result,job.worker_id))throw new JobEffectLeaseLost();
    return result;
   });
  }catch(error){
   await settle(async tx=>{
    await lockCurrentJobClaim(tx,job);
    const held=runId?(await tx.query<{status:string;provider_task_snapshot_id:string|null;provider_task_control_id:string|null;provider_task_delivery_id:string|null;model_provider_id:string|null}>('SELECT status,provider_task_snapshot_id,provider_task_control_id,provider_task_delivery_id,model_provider_id FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE',[runId,job.space_id])).rows[0]:null;
    if(attempt&&held?.status!=='queued'&&(!held||held.provider_task_snapshot_id!==attempt.invocation_snapshot_id||held.provider_task_control_id!==attempt.control_id||held.provider_task_delivery_id!==attempt.delivery_id||held.model_provider_id!==attempt.provider_id))throw new JobEffectLeaseLost('Research failure no longer owns its provider attempt');
    const current=await new PgJobQueueRepository(tx).getJob(job.job_id);
    if(!current||hash(current.payload_json.intent)!==stored.payload_json.intent_hash||current.payload_json.run_id!==runId)throw new JobEffectLeaseLost();
    await audit(tx);
    if(runId)await failBoundedProviderTaskRun(tx,job.space_id,runId,{code:'research_evaluation_failed',message:error instanceof Error?error.message:'Research evaluation failed'});
    await tx.query(`UPDATE jobs SET result_json=COALESCE(result_json,'{}'::jsonb)||'{"research_evaluation_retry_safe":true}'::jsonb WHERE id=$1 AND result_json->>'effect_started' IS DISTINCT FROM 'true'`,[job.job_id]);
    if(await new PgJobQueueRepository(tx).failJob(job.job_id,'Research evaluation failed; sent work will not be repeated',job.worker_id)!=='failed')throw new JobEffectLeaseLost();
   });
   throw error;
  }
 });
}

/** Audit joins the owner transaction; no business result survives its failure. */
export async function auditRunJob(db:Queryable,config:ServerConfig,intent:Pick<Intent,'actor'|'strategy_id'>){
 const a=intent.actor;
 const decision=await enforce({...config,auditTransaction:db},await loadActionRegistry(config),{action:'source.connection.manage',force_record:true,actor_type:'user',actor_id:a.on_behalf_of_user_id!,space_id:a.space_id,resource_type:'source_channel',resource_id:intent.strategy_id,context:{trigger_origin:a.effective_origin}});
 if(decision.status!=='allow'||!decision.policy_decision_record_id)throw new HttpError(403,'Research evaluation refused');
}

/** The queue never releases stored strategy content through its generic DTO. */
export async function readEvaluationResult(db:Queryable,config:ServerConfig,actor:protocol.OperationActor,jobId:string){
 return withQueryableTransaction(db,async tx=>{
  const job=await new PgJobQueueRepository(tx).getJob(jobId);
  if(!job||job.job_type!==RESEARCH_EVALUATION_JOB||job.space_id!==actor.space_id||job.user_id!==actor.on_behalf_of_user_id)throw new HttpError(404,'Research evaluation unavailable');
  const intent=IntentSchema.parse(job.payload_json.intent);
  if(intent.actor.principal.kind!=='user'||intent.actor.principal.id!==actor.principal.id||hash(intent)!==job.payload_json.intent_hash)throw new HttpError(404,'Research evaluation unavailable');
  await admitStrategy(tx,config,actor,intent.strategy_id);
  await auditRunJob(tx,config,{actor,strategy_id:intent.strategy_id});
  const current=await new PgJobQueueRepository(tx).getJob(jobId);
  if(!current||current.payload_json.intent_hash!==job.payload_json.intent_hash)throw conflict('Research evaluation changed');
  const result=current.status==='completed'?protocol.EvaluateResearchQueryStrategyResponseSchema.parse(current.result_json):null;
  return protocol.ResearchQueryEvaluationResultSchema.parse({job_id:jobId,strategy_id:intent.strategy_id,run_id:current.payload_json.run_id,status:current.status==='completed'?'succeeded':current.status==='running'?'running':['failed','cancelled'].includes(current.status)?current.status:'queued',result});
 });
}
