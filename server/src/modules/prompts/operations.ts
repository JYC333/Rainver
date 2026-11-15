import {PROMPT_QUERY_IDS,type OperationActor,type PromptOperationId,type PromptOperationInput as In,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {lockEvolutionAssets} from '../evolution/assetLocks.js';
import {assertCanResolveForScopes} from '../evolution/assetAccess.js';
import {assertProposalVisible,evolutionAssetRefusal} from '../evolution/assetOperations.js';
import {PromptRepository,findPromptAssetForKey} from './repository.js';
import {resolvePrompt} from './resolver.js';

const IDS=['prompt.version.create','prompt.deployment.set','prompt.deployment.rollback','prompt.evaluation.record','prompt.promotion.propose','prompt.render_preview','prompt.resolve'] as const satisfies readonly PromptOperationId[];
type Id=(typeof IDS)[number];
const QUERIES=new Set<string>(PROMPT_QUERY_IDS);
const who=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const drop=(input:Record<string,unknown>,...keys:string[])=>Object.fromEntries(Object.entries(input).filter(([k])=>!keys.includes(k)));

/**
 * Prompt facade commands over PromptRepository, which keeps the asset
 * owner-scope, deployment-scope, Reading-method scope and production rules.
 * Each command takes the canonical lock of the prompt asset it resolves, so
 * a deployment's version and promotion checks hold until the ref is written.
 * Production promotion is a Proposal for the canonical applier. Render
 * preview and resolution are read-only queries.
 */
export function promptOperationRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return IDS.map(id=>({
  definition:defs.get(id)!,
  ...(QUERIES.has(id)?{readKind:'metadata' as const}:{}),
  successStatus:id==='prompt.version.create'||id==='prompt.evaluation.record'||id==='prompt.promotion.propose'?201:200,
  async resolve(_db,raw,a){
   const key=(raw as {asset_key:string}).asset_key;
   return {authority:`prompt_asset:${a.space_id}:${key}`,targets:{asset_key:key},resourceType:'evolvable_asset',resourceId:null};
  },
  async authorize(db,raw,a){
   if(QUERIES.has(id))return;
   const found=await findPromptAssetForKey(db,who(a),(raw as {asset_key:string}).asset_key);
   if(!found)throw hidden();
   await lockEvolutionAssets(db,[found.row.id]);
  },
  async authorizeResult(db,raw,a){
   if(QUERIES.has(id))return;
   const out=raw as {space_id:string;asset_key?:string;proposal_id?:string};
   if(out.space_id!==a.space_id)throw hidden();
   if(out.asset_key)await new PromptRepository(db).getAsset(who(a),out.asset_key);
   if(out.proposal_id)await assertProposalVisible(db,a,out.proposal_id);
  },
  classifyError:error=>evolutionAssetRefusal(error,'prompts'),
  async execute(db,raw,a){
   const p=who(a),repo=new PromptRepository(db),i=raw as In<Id>&{asset_key:string},base={space_id:a.space_id,asset_key:i.asset_key};
   switch(id){
    case 'prompt.version.create':return {...base,version_id:String((await repo.createVersion(p,i.asset_key,drop(i,'asset_key'))).id)};
    case 'prompt.deployment.set':{const d=raw as In<'prompt.deployment.set'>;return {...base,deployment_id:String((await repo.setDeployment(p,d.asset_key,d.label,drop(d,'asset_key','label'))).id)};}
    case 'prompt.deployment.rollback':return {...base,deployment_id:String((await repo.rollbackDeployment(p,i.asset_key,drop(i,'asset_key'))).id)};
    case 'prompt.evaluation.record':return {...base,evaluation_run_id:String((await repo.recordEvaluation(p,i.asset_key,drop(i,'asset_key'))).id)};
    case 'prompt.promotion.propose':{const out=await repo.createPromotionProposal(p,i.asset_key,drop(i,'asset_key'));return {space_id:a.space_id,proposal_id:String(out.proposal_id),status:String(out.status),proposal_type:String(out.proposal_type)};}
    case 'prompt.render_preview':return repo.renderPreview(p,i.asset_key,drop(i,'asset_key'));
    case 'prompt.resolve':{
     const r=raw as In<'prompt.resolve'>,projectId=r.project_id??null,agentId=r.agent_id??null;
     await assertCanResolveForScopes(db,p,{projectId,agentId});
     return resolvePrompt(db,{spaceId:p.spaceId,userId:p.userId,assetKey:r.asset_key,projectId,agentId,explicitVersionId:r.explicit_version_id??null,allowUserPin:r.allow_user_pin===true,label:r.label??null,variables:r.variables});
    }
   }
  },
 }));
}

/** Retained prompt facade URLs; the asset key is the URL target. */
export function registerPromptOperationRoutes(app:FastifyInstance,config:ServerConfig):void{
 const base='/api/v1/prompts/assets/:assetKey',key={assetKey:'asset_key'};
 registerOperationAdapters(app,config,[
  {method:'POST',url:`${base}/versions`,operation:'prompt.version.create',params:key},
  {method:'PUT',url:`${base}/deployments/:label`,operation:'prompt.deployment.set',params:{...key,label:'label'}},
  {method:'POST',url:`${base}/rollback`,operation:'prompt.deployment.rollback',params:key},
  {method:'POST',url:`${base}/evaluate`,operation:'prompt.evaluation.record',params:key},
  {method:'POST',url:`${base}/promote`,operation:'prompt.promotion.propose',params:key},
  {method:'POST',url:`${base}/render-preview`,operation:'prompt.render_preview',params:key},
  {method:'POST',url:`${base}/resolve`,operation:'prompt.resolve',params:key},
 ]);
}
