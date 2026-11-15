import type {OperationActor,PromptOperationId,PromptOperationInput as In,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../../config.js';
import type {Queryable} from '../../routeUtils/common.js';
import type {OperationRegistration} from '../../systemActions/operations/types.js';
import {hidden} from '../../systemActions/operations/errors.js';
import {registerOperationAdapters} from '../../systemActions/operations/routeAdapter.js';
import {canViewVersionScope} from '../../evolution/assetAccess.js';
import {assertProposalVisible,evolutionAssetRefusal} from '../../evolution/assetOperations.js';
import {PromptRepository} from '../repository.js';
import {initializeReading,saveReadingDraft,saveReadingSample,readReadingSample} from './workspace.js';
import {startReadingGeneration,readReadingGeneration,requestReadingGenerationCancel,stopReadingRun} from './generation.js';
import {startReadingTrial,judgeReadingTrial,requestReadingTrialCancel,finishReadingTrialCancel} from './trials.js';
import {proposeReadingMethod,rollbackReadingMethod} from './commands.js';
import {READING_METHOD_KEY} from './runtime.js';
import {PgRunRepository} from '../../runs/repository.js';
import {getDbPool} from '../../../db/pool.js';

const IDS=['reading_method.initialize','reading_method.draft.save','reading_method.sample.save','reading_method.generation.start','reading_method.generation.cancel','reading_method.trial.start','reading_method.trial.cancel','reading_method.trial.judge','reading_method.promotion.propose','reading_method.rollback'] as const satisfies readonly PromptOperationId[];
const who=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type CancelOut={space_id:string;generation_id?:string;trial_id?:string};
/** One's own comparison: the two Runs it started (the cancel admits both before any domain lock). */
async function trialRuns(db:Queryable,a:OperationActor,trialId:string){
 const ref=(await db.query<{eval_suite_ref_json:{baseline_run_id?:string;candidate_run_id?:string}}>(`SELECT eval_suite_ref_json FROM evolvable_asset_evaluation_runs WHERE id=$1 AND space_id=$2 AND created_by_user_id=$3 AND evaluator_version='reading_method_pair.v1'`,[trialId,a.space_id,a.on_behalf_of_user_id])).rows[0]?.eval_suite_ref_json;
 return [...new Set([ref?.baseline_run_id,ref?.candidate_run_id].filter((v):v is string=>!!v))].sort().map(id=>({space_id:a.space_id,id}));
}

/**
 * Reading Method commands over the workspace owners, which take their own
 * per-person advisory lock, then the method asset lock, then the Project
 * audience, and recheck the frozen effective method. Generations and
 * comparisons commit their queued Run(s), closed context and agent_run or
 * provider Job intent together; the work runs in that Job. A cancel records
 * the stop here (a provider task ends, an Agent Run is marked cancelling) and
 * the Agent process stop and comparison settlement run after commit; both
 * are also recovered by their sweeps. Promotion is the canonical prompt
 * promotion Proposal. Receipts carry ids; the GET readers release content.
 */
export function readingMethodOperationRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return IDS.map(id=>({
  definition:defs.get(id)!,
  successStatus:id==='reading_method.generation.start'||id==='reading_method.trial.start'?202:id==='reading_method.draft.save'||id==='reading_method.sample.save'||id==='reading_method.promotion.propose'?201:200,
  ...(id==='reading_method.generation.cancel'?{runTerminalOwner:{discover:async(_db:Queryable,raw:unknown,a:OperationActor)=>[{space_id:a.space_id,id:(raw as {generation_id:string}).generation_id}]}}:{}),
  ...(id==='reading_method.trial.cancel'?{runTerminalOwner:{discover:(db:Queryable,raw:unknown,a:OperationActor)=>trialRuns(db,a,(raw as {trial_id:string}).trial_id)}}:{}),
  async resolve(_db,raw,a){
   const i=raw as {generation_id?:string;trial_id?:string;target_key?:string};
   if(i.generation_id)return {authority:`reading_generation:${i.generation_id}`,targets:{generation_id:i.generation_id},resourceType:'run',resourceId:i.generation_id};
   if(i.trial_id)return {authority:`reading_trial:${i.trial_id}`,targets:{trial_id:i.trial_id},resourceType:'evolvable_asset_evaluation_run',resourceId:i.trial_id};
   return {authority:`reading_method:${a.space_id}:${i.target_key??READING_METHOD_KEY}`,targets:{target_key:i.target_key??READING_METHOD_KEY},resourceType:'evolvable_asset',resourceId:null};
  },
  // Every owner checks Space management, material, Project and method authority under its own locks.
  async authorize(){},
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;version_id?:string;case_id?:string;generation_id?:string;trial_id?:string;proposal_id?:string;asset_key?:string};
   if(out.space_id!==a.space_id)throw hidden();
   const p=who(a);
   if(out.version_id){const version=(await db.query<{space_id:string|null;scope_type:string;scope_id:string|null}>('SELECT space_id,scope_type,scope_id FROM evolvable_asset_versions WHERE id=$1',[out.version_id])).rows[0];if(!version||!await canViewVersionScope(db,p,version))throw hidden();}
   if(out.case_id)await readReadingSample(db,p,out.case_id);
   if(out.generation_id)await readReadingGeneration(db,p,out.generation_id);
   if(out.trial_id&&!(await trialRuns(db,a,out.trial_id)).length)throw hidden();
   if(out.proposal_id)await assertProposalVisible(db,a,out.proposal_id);
   if(out.asset_key)await new PromptRepository(db).getAsset(p,out.asset_key);
  },
  classifyError:error=>evolutionAssetRefusal(error,'prompts'),
  async execute(db,raw,a){
   const p=who(a),base={space_id:a.space_id};
   switch(id){
    case 'reading_method.initialize':await initializeReading(db,config,p);return {...base,initialized:true as const};
    case 'reading_method.draft.save':return {...base,version_id:String((await saveReadingDraft(db,p,raw)).id)};
    case 'reading_method.sample.save':{const i=raw as In<'reading_method.sample.save'>;return {...base,case_id:String((await saveReadingSample(db,p,i.item_id,i.project_id??null,i.sample,config,i.target_key)).id)};}
    case 'reading_method.generation.start':return {...base,generation_id:(await startReadingGeneration(db,p,raw)).id};
    case 'reading_method.generation.cancel':{const i=raw as In<'reading_method.generation.cancel'>;await requestReadingGenerationCancel(db,p,i.generation_id);return {...base,generation_id:i.generation_id};}
    case 'reading_method.trial.start':return {...base,trial_id:(await startReadingTrial(db,config,p,raw)).id};
    case 'reading_method.trial.cancel':{const i=raw as In<'reading_method.trial.cancel'>;await requestReadingTrialCancel(db,p,i.trial_id);return {...base,trial_id:i.trial_id};}
    case 'reading_method.trial.judge':{const i=raw as In<'reading_method.trial.judge'>;await judgeReadingTrial(db,p,i.trial_id,{judgment:i.judgment,reason:i.reason});return {...base,trial_id:i.trial_id};}
    case 'reading_method.promotion.propose':{const i=raw as In<'reading_method.promotion.propose'>;return {...base,proposal_id:String((await proposeReadingMethod(db,p,i.version_id,i.evaluation_id,i.project_id??null)).proposal_id)};}
    case 'reading_method.rollback':{const i=raw as In<'reading_method.rollback'>,key=i.target_key??READING_METHOD_KEY;return {...base,asset_key:key,deployment_id:String((await rollbackReadingMethod(db,p,i.item_id??null,i.project_id??null,i.expected_version_id,key)).id)};}
   }
  },
  ...(id==='reading_method.generation.cancel'||id==='reading_method.trial.cancel'?{async afterCommit(raw:unknown,a:OperationActor){
   // Derived from committed state, never from input: one's own provider tasks
   // that ended are settled onto the comparison; Agent Runs still cancelling are stopped.
   const out=raw as CancelOut,p=who(a),pool=getDbPool(config.databaseUrl!),runs=new PgRunRepository(pool);
   const ids=id==='reading_method.trial.cancel'?(await trialRuns(pool,a,out.trial_id!)).map(r=>r.id):[out.generation_id!];
   const settle:string[]=[],stop:string[]=[];
   for(const runId of ids){const run=await runs.getRun(a.space_id,runId);if(!run||run.instructed_by_user_id!==p.userId)continue;if(run.execution_kind==='provider_task')settle.push(runId);else if(run.status==='cancelling')stop.push(runId);}
   if(id==='reading_method.trial.cancel'){await finishReadingTrialCancel(pool,config,p,{settle,stop});return;}
   for(const runId of stop)await stopReadingRun(config,p,runId);
  }}:{}),
 }));
}

/** Retained Reading Method URLs. */
export function registerReadingMethodOperationRoutes(app:FastifyInstance,config:ServerConfig):void{
 const base='/api/v1/prompts/reading-method';
 registerOperationAdapters(app,config,[
  {method:'POST',url:`${base}/initialize`,operation:'reading_method.initialize'},
  {method:'POST',url:`${base}/drafts`,operation:'reading_method.draft.save'},
  {method:'POST',url:`${base}/samples`,operation:'reading_method.sample.save'},
  {method:'POST',url:`${base}/generations`,operation:'reading_method.generation.start'},
  {method:'POST',url:`${base}/generations/:id/cancel`,operation:'reading_method.generation.cancel',params:{id:'generation_id'}},
  {method:'POST',url:`${base}/trials`,operation:'reading_method.trial.start'},
  {method:'POST',url:`${base}/trials/:id/cancel`,operation:'reading_method.trial.cancel',params:{id:'trial_id'}},
  {method:'POST',url:`${base}/trials/:id/judgment`,operation:'reading_method.trial.judge',params:{id:'trial_id'}},
  {method:'POST',url:`${base}/promote`,operation:'reading_method.promotion.propose'},
  {method:'POST',url:`${base}/rollback`,operation:'reading_method.rollback'},
 ]);
}
