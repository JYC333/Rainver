import {EVOLUTION_ASSET_OPERATION_SCHEMAS,EVOLUTION_ASSET_QUERY_IDS,type EvolutionAssetOperationId,type EvolutionAssetOperationInput as In,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../config.js';
import {objectValue,optionalString,type Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationRefusal,hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {RunCreateValidationError} from '../runs/repository.js';
import {RunBudgetExceededError,RunBudgetSourceReferenceError} from '../runs/budgetEnforcement.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {canReadAgent} from '../agents/agentAccess.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {PgRunRepository} from '../runs/repository.js';
import {EvolutionAssetRefusal} from './assetRefusal.js';
import {lockEvolutionAssetKeys,lockEvolutionAssets} from './assetLocks.js';
import {assertCanResolveForScopes} from './assetAccess.js';
import {EvolvableAssetRepository} from './assetRepository.js';
import {EvolvableAssetEvaluationRepository} from './assetEvaluationRepository.js';
import {resolveEvolvableAssetVersion} from './assetResolutionService.js';
import {EvaluationHarnessService} from './evaluationHarnessService.js';
import {RunWorkflowService,type SaveRunAsWorkflowInput} from './runWorkflowService.js';
import {createEvolutionBundle} from './bundleRepository.js';
import {EvolutionCommandError,EvolutionNoStrategySelected,EvolutionRepository} from './repository.js';

type Id=EvolutionAssetOperationId;
const IDS=Object.keys(EVOLUTION_ASSET_OPERATION_SCHEMAS) as Id[];
const QUERIES=new Set<string>(EVOLUTION_ASSET_QUERY_IDS);
const who=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
/** Commands that change one asset's versions, pins, cases, evaluations or promotion set. */
const ASSET_COMMANDS=new Set<Id>(['evolution.asset.version.create','evolution.asset.version.update','evolution.asset.version.transition','evolution.asset.pin.set','evolution.asset.pin.archive','evolution.asset.evaluation_case.create','evolution.asset.evaluation_case.create_from_run','evolution.asset.evaluation.record','evolution.asset.evaluation.execute','evolution.asset.promotion.propose']);
const drop=<T extends Record<string,unknown>>(input:T,...keys:string[])=>Object.fromEntries(Object.entries(input).filter(([k])=>!keys.includes(k)));

/** The owners' marked refusals; a daily limit is a deterministic conflict for this key. Anything else stays internal. */
export function evolutionAssetRefusal(error:unknown,domain:string):OperationRefusal|undefined{
 if(error instanceof EvolutionAssetRefusal)return new OperationRefusal(error.statusCode===422?422:409,domain,error.message,error.responseBody);
 if(error instanceof EvolutionCommandError)return new OperationRefusal(error.statusCode,domain,error.message);
 // Run creation and budget admission refusals, as the Agent Run commands classify them.
 if(error instanceof RunCreateValidationError||error instanceof RunBudgetExceededError||error instanceof RunBudgetSourceReferenceError)return markedRefusal(error as Error&{statusCode:number},domain);
 return undefined;
}
/** A proposal receipt is released only while the person can still see that Proposal. */
export async function assertProposalVisible(db:Queryable,a:OperationActor,proposalId:string){
 if(await contentDecisionFromDb(db,who(a),'proposal',proposalId,{includeOversight:false})==='deny')throw hidden();
}

/**
 * Evolvable-asset, evaluation, workflow-from-Run, bundle and Evolution Run
 * commands over the existing owners, which keep their owner-scope, lifecycle,
 * evaluation and risk rules. Every command on an existing asset takes the
 * canonical asset lock first, the order promotion apply and rollback use, so
 * a version's state is checked and written under one lock until commit.
 * Asset creation serializes on the Space's asset-key lock. Promotion and
 * workflow-save Proposals are written by the owners for the canonical
 * applier; nothing here decides one. The Evolution Run is queued with its
 * agent_run Job and executes in that Job. Receipts carry ids; replays are
 * released only while the asset, Proposal, bundle or Run is still readable.
 */
export function evolutionAssetOperationRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return IDS.map(id=>({
  definition:defs.get(id)!,
  ...(QUERIES.has(id)?{readKind:'metadata' as const}:{}),
  successStatus:id==='evolution.asset.evaluation.execute'||id==='evolution.target.run'?202:id.endsWith('.create')||id.endsWith('.create_from_run')||id==='evolution.asset.evaluation.record'||id==='evolution.asset.promotion.propose'||id==='evolution.workflow.save'?201:200,
  async resolve(_db,raw,a){
   const i=raw as {asset_id?:string;run_id?:string;target_id?:string};
   if(i.asset_id)return {authority:`evolvable_asset:${i.asset_id}`,targets:{asset_id:i.asset_id},resourceType:'evolvable_asset',resourceId:i.asset_id};
   if(id==='evolution.target.run')return {authority:`evolution_target:${i.target_id}`,targets:{target_id:i.target_id},resourceType:'evolution_target',resourceId:i.target_id!};
   if(i.run_id)return {authority:`run:${i.run_id}`,targets:{run_id:i.run_id},resourceType:'run',resourceId:i.run_id};
   return {authority:`space:${a.space_id}`,targets:{space_id:a.space_id},resourceType:id==='evolution.bundle.create'?'evolution_bundle':'evolvable_asset',resourceId:null};
  },
  async authorize(db,raw,a){
   if(ASSET_COMMANDS.has(id)){await lockEvolutionAssets(db,[(raw as {asset_id:string}).asset_id]);return;}
   if(id==='evolution.asset.create'||id==='evolution.workflow.save')await lockEvolutionAssetKeys(db,a.space_id);
   // A Run start holds its target from before the first runnable read to commit (target writer order: the target row first).
   if(id==='evolution.target.run')await new EvolutionRepository(db).lockTargetForRun(who(a),(raw as {target_id:string}).target_id);
   // Owner-scope write authority, Run visibility and Project writer checks stay in each owner, under these locks.
  },
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;asset_id?:string;proposal_id?:string;bundle_id?:string;run_id?:string;target_id?:string};
   if(QUERIES.has(id))return;
   if(out.space_id!==a.space_id)throw hidden();
   if(out.asset_id)await new EvolvableAssetRepository(db).getAsset(who(a),out.asset_id);
   if(out.proposal_id)await assertProposalVisible(db,a,out.proposal_id);
   if(out.bundle_id&&!(await db.query('SELECT id FROM evolution_bundles WHERE id=$1 AND space_id=$2',[out.bundle_id,a.space_id])).rows.length)throw hidden();
   if(out.target_id&&!await new EvolutionRepository(db).getTargetRow(who(a),out.target_id))throw hidden();
   if(out.run_id&&!await new PgRunRepository(db).getVisibleRun(a.space_id,a.on_behalf_of_user_id!,out.run_id))throw hidden();
  },
  classifyError:error=>evolutionAssetRefusal(error,'evolution'),
  async execute(db,raw,a){
   const p=who(a),assets=new EvolvableAssetRepository(db),evaluations=new EvolvableAssetEvaluationRepository(db),harness=new EvaluationHarnessService(db);
   const base={space_id:a.space_id};
   switch(id){
    case 'evolution.asset.create':{const out=await assets.createAsset(p,raw as In<'evolution.asset.create'>);return {...base,asset_id:String(out.id)};}
    case 'evolution.asset.version.create':{const i=raw as In<'evolution.asset.version.create'>;const out=await assets.createVersion(p,i.asset_id,drop(i,'asset_id','content_hash'));return {...base,asset_id:i.asset_id,version_id:String(out.id)};}
    case 'evolution.asset.version.update':{const i=raw as In<'evolution.asset.version.update'>;await assets.updateVersionContent(p,i.asset_id,i.version_id,drop(i,'asset_id','version_id','content_hash'));return {...base,asset_id:i.asset_id,version_id:i.version_id};}
    case 'evolution.asset.version.transition':{const i=raw as In<'evolution.asset.version.transition'>;await assets.transitionVersionStatus(p,i.asset_id,i.version_id,{status:i.status});return {...base,asset_id:i.asset_id,version_id:i.version_id};}
    case 'evolution.asset.pin.set':{const i=raw as In<'evolution.asset.pin.set'>;const out=await assets.setPin(p,i.asset_id,i.scope_type,i.scope_id,{version_id:i.version_id,reason:i.reason??null});return {...base,asset_id:i.asset_id,scope_type:i.scope_type,scope_id:i.scope_id,pin_id:String(out.id)};}
    case 'evolution.asset.pin.archive':{const i=raw as In<'evolution.asset.pin.archive'>;await assets.archivePin(p,i.asset_id,i.scope_type,i.scope_id);return {...base,asset_id:i.asset_id,scope_type:i.scope_type,scope_id:i.scope_id,pin_id:null};}
    case 'evolution.asset.resolve':{
     const i=raw as In<'evolution.asset.resolve'>,asset=await assets.getAsset(p,i.asset_id),projectId=i.project_id??null,agentId=i.agent_id??null;
     await assertCanResolveForScopes(db,p,{projectId,agentId});
     return {...await resolveEvolvableAssetVersion(db,{assetId:String(asset.id),spaceId:p.spaceId,assetKey:String(asset.asset_key),assetType:String(asset.asset_type),projectId,userId:p.userId,agentId,explicitVersionId:i.explicit_version_id??null,allowUserPin:i.allow_user_pin===true})};
    }
    case 'evolution.asset.evaluation_case.create':{const i=raw as In<'evolution.asset.evaluation_case.create'>;const out=await harness.createCase(p,i.asset_id,drop(i,'asset_id') as never);return {...base,asset_id:i.asset_id,case_id:String(out.id)};}
    case 'evolution.asset.evaluation_case.create_from_run':{const i=raw as In<'evolution.asset.evaluation_case.create_from_run'>;const out=await harness.createCaseFromRun(p,i.asset_id,drop(i,'asset_id') as never);return {...base,asset_id:i.asset_id,case_id:String(out.id)};}
    case 'evolution.asset.evaluation.record':{const i=raw as In<'evolution.asset.evaluation.record'>;const out=await evaluations.recordEvaluationRun(p,i.asset_id,i.version_id,drop(i,'asset_id','version_id'));return {...base,asset_id:i.asset_id,evaluation_run_id:String(out.id)};}
    case 'evolution.asset.evaluation.execute':{const i=raw as In<'evolution.asset.evaluation.execute'>;const out=await harness.startEvaluation(p,i.asset_id,i.version_id,i.case_id,{candidate_run_id:i.candidate_run_id}) as {evaluation_run:{id:string};job_id:string};return {...base,asset_id:i.asset_id,evaluation_run_id:out.evaluation_run.id,job_id:out.job_id,connector_mode:'mock_read_only' as const};}
    case 'evolution.asset.promotion.propose':{const i=raw as In<'evolution.asset.promotion.propose'>;const out=await evaluations.createPromotionProposal(p,i.asset_id,i.version_id,drop(i,'asset_id','version_id'));return {...base,proposal_id:String(out.proposal_id),status:String(out.status),proposal_type:String(out.proposal_type)};}
    case 'evolution.workflow.preview':return {...await new RunWorkflowService(db).preview(p,raw as SaveRunAsWorkflowInput)};
    case 'evolution.workflow.save':{
     const out=await new RunWorkflowService(db).save(p,raw as SaveRunAsWorkflowInput);
     return out.status==='proposal_required'
      ?{...base,status:'proposal_required' as const,proposal_id:String(out.proposal_id),proposal_type:'workflow_save' as const,risk_level:String(out.risk_level)}
      :{...base,status:'draft_saved' as const,asset_id:String(out.asset_id),version_id:String(out.version_id),version_status:'draft' as const,risk_level:String(out.risk_level)};
    }
    case 'evolution.bundle.create':{const i=raw as In<'evolution.bundle.create'>;return {...base,bundle_id:await createEvolutionBundle(db,p,{title:i.title,description:i.description??null,proposalIds:i.proposal_ids})};}
    case 'evolution.target.run':{
     const i=raw as In<'evolution.target.run'>,repo=new EvolutionRepository(db);
     const target=await repo.getTargetRow(p,i.target_id);
     if(!target)throw hidden();
     const agentId=i.agent_id??optionalString(objectValue(target.metadata_json).agent_id);
     if(!agentId)throw new EvolutionAssetRefusal(422,'agent_id is required in the request or target metadata');
     if(!await canReadAgent(db,p,agentId))throw hidden();
     let setup:Awaited<ReturnType<EvolutionRepository['recordRunSetup']>>;
     try{setup=await repo.recordRunSetup(p,i.target_id,agentId,drop(i,'target_id','agent_id'));}
     catch(error){
      // The selector decision explaining the miss stays recorded; no Run exists.
      if(error instanceof EvolutionNoStrategySelected)return {...base,status:'not_selected' as const,target_id:i.target_id,selector_decision_id:error.selectorDecisionId,reason:error.message};
      throw error;
     }
     const run=await new PgRunRepository(db).getRun(a.space_id,setup.runId);
     const job=await new PgJobQueueRepository(db).ensureAgentRunJob({job_type:'agent_run',space_id:a.space_id,user_id:p.userId,agent_id:agentId,project_folder_id:run?.project_folder_id??null,payload:{run_id:setup.runId}});
     return {...base,status:'queued' as const,target_id:setup.targetId,run_id:setup.runId,job_id:job.id,selector_decision_id:setup.selectorDecisionId,selected_strategy_key:setup.selectedStrategyKey};
    }
   }
  },
 }));
}

/** Retained Evolution asset, workflow, bundle-creation and Run URLs. */
export function registerEvolutionAssetOperationRoutes(app:FastifyInstance,config:ServerConfig):void{
 const asset='/api/v1/evolution/assets/:assetId',version=`${asset}/versions/:versionId`;
 registerOperationAdapters(app,config,[
  {method:'POST',url:'/api/v1/evolution/assets',operation:'evolution.asset.create'},
  {method:'POST',url:`${asset}/versions`,operation:'evolution.asset.version.create',params:{assetId:'asset_id'}},
  {method:'PATCH',url:version,operation:'evolution.asset.version.update',params:{assetId:'asset_id',versionId:'version_id'}},
  {method:'POST',url:`${version}/transition`,operation:'evolution.asset.version.transition',params:{assetId:'asset_id',versionId:'version_id'}},
  {method:'PUT',url:`${asset}/pins/:scopeType/:scopeId`,operation:'evolution.asset.pin.set',params:{assetId:'asset_id',scopeType:'scope_type',scopeId:'scope_id'}},
  {method:'DELETE',url:`${asset}/pins/:scopeType/:scopeId`,operation:'evolution.asset.pin.archive',params:{assetId:'asset_id',scopeType:'scope_type',scopeId:'scope_id'}},
  {method:'POST',url:`${asset}/resolve`,operation:'evolution.asset.resolve',params:{assetId:'asset_id'}},
  {method:'POST',url:`${asset}/evaluation-cases`,operation:'evolution.asset.evaluation_case.create',params:{assetId:'asset_id'}},
  {method:'POST',url:`${asset}/evaluation-cases/from-run`,operation:'evolution.asset.evaluation_case.create_from_run',params:{assetId:'asset_id'}},
  {method:'POST',url:`${version}/evaluate`,operation:'evolution.asset.evaluation.record',params:{assetId:'asset_id',versionId:'version_id'}},
  {method:'POST',url:`${version}/evaluation-cases/:caseId/execute`,operation:'evolution.asset.evaluation.execute',params:{assetId:'asset_id',versionId:'version_id',caseId:'case_id'}},
  {method:'POST',url:`${version}/promote-proposal`,operation:'evolution.asset.promotion.propose',params:{assetId:'asset_id',versionId:'version_id'}},
  {method:'POST',url:'/api/v1/evolution/workflows/from-run/preview',operation:'evolution.workflow.preview'},
  {method:'POST',url:'/api/v1/evolution/workflows/from-run/save',operation:'evolution.workflow.save'},
  {method:'POST',url:'/api/v1/evolution/bundles',operation:'evolution.bundle.create'},
  {method:'POST',url:'/api/v1/evolution/targets/:targetId/run',operation:'evolution.target.run',params:{targetId:'target_id'}},
 ]);
}
