import { resolveRevisionMethod, REVISION_METHOD_KEY } from './revisionMethod.js';
import {listReadingGenerations} from './generation.js';
import type {ReadingMethodContext} from '@rainver/protocol';
import {ReadingMethodDraftSchema,ReadingMethodSampleSchema} from '@rainver/protocol';
import {HttpError,withDbTransaction,type Pool,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import type {ServerConfig} from '../../../config.js';
import {readingItemContext} from '../../sources/index.js';
import {PromptRepository} from '../repository.js';
import {resolvePrompt} from '../resolver.js';
import {syncBuiltinPrompts} from '../builtins.js';
import {assertCanWriteAssetOwnerScope} from '../../evolution/assetAccess.js';
import {EvaluationHarnessService} from '../../evolution/evaluationHarnessService.js';
import {lockEvolutionAssets} from '../../evolution/assetLocks.js';
import {readingAsset} from './access.js';
import {READING_METHOD_KEY,freezeReadingMethod,readingStrategy} from './runtime.js';
import {sha256Json} from '../hash.js';
import {assertSafeGoalMessage} from '../../sources/goals/messageSafety.js';
import {prepareSampleAuthority,assertSampleAuthority,sampleContentChanged} from './sampleAuthority.js';
import {canWriteProject} from '../../projects/access.js';
import {PAIR_EVALUATOR,readReadingTrial} from './trials.js';

export async function readingWorkspace(db:Queryable,identity:SpaceUserIdentity,itemId:string,projectId?:string|null,entryOnly=false,config?:ServerConfig,expectedArtifactId?:string,targetKey=READING_METHOD_KEY):Promise<ReadingMethodContext>{
 const ctx=await readingItemContext(db,identity,itemId,projectId);
 const row=(await db.query(`SELECT role FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active'`,[identity.spaceId,identity.userId])).rows[0];
 let canManage=['owner','admin'].includes(String(row?.role)) && (!ctx.projectId||await canWriteProject(db,identity.spaceId,ctx.projectId,identity.userId));
 const base:ReadingMethodContext={target_key:targetKey,item_id:ctx.item.id,item_title:ctx.item.title??'',project_id:ctx.projectId,project_name:ctx.context?.name?String(ctx.context.name):null,can_manage:canManage,initialized:false,effective_version_id:null,effective_version:null,effective_scope:null,method:null,result_provenance:null,versions:[],cases:[],trials:[],runtimes:[]};
 let asset;try{asset=await readingAsset(db,identity,false,targetKey);}catch(e){if(e instanceof HttpError&&e.statusCode===409)return base;throw e;}
 try{await assertCanWriteAssetOwnerScope(db,identity,asset);}catch(e){if(!(e instanceof HttpError)||e.statusCode!==403)throw e;canManage=false;}
 base.can_manage=canManage;base.initialized=true;if(entryOnly)return base;
 // Existing installations may have synchronized only the investigation asset.
 try{await resolveRevisionMethod(db,identity,ctx.projectId);}catch(e){if(e instanceof HttpError&&e.statusCode===409)base.initialized=false;else throw e;}
 try{const effective=await resolvePrompt(db,{...identity,assetKey:targetKey,projectId:ctx.projectId});base.effective_version_id=effective.version_id;base.effective_scope=effective.scope_type?String(effective.scope_type):null;base.method=effective.rendered_text;const v=(await db.query(`SELECT version FROM evolvable_asset_versions WHERE id=$1`,[effective.version_id])).rows[0];base.effective_version=Number(v?.version);}
 catch(e){if(!(e instanceof HttpError)||![404,409].includes(e.statusCode))throw e;}
 // A result without recorded provenance remains unknown; never infer it from the current deployment.
 let metadata=ctx.item.metadata_json as Record<string,unknown>;
 if(config){const shown=await new (await import('../../reader/index.js')).PgReaderRepository(db,config).shownSourceItemVersion(identity,itemId);if(expectedArtifactId && shown?.artifactId!==expectedArtifactId)throw new HttpError(409,'The Reader version changed; reopen the result before improving it');if(shown)metadata=shown.content.metadata;}
 const provenance=metadata?.reading_method_provenance as {version_id?:string;content_hash?:string}|undefined;
 if(provenance?.version_id){
  const v=(await db.query(`SELECT id,version,content_hash FROM evolvable_asset_versions WHERE id=$1 AND asset_id=$2`,[provenance.version_id,asset.id])).rows[0];
  const runId=typeof metadata.agent_run_id==='string'?metadata.agent_run_id:null;
  const run=runId?await new (await import('../../runs/repository.js')).PgRunRepository(db).getRun(identity.spaceId,runId):null;
  const recorded=run?(await import('./runtime.js')).readingMethodOf(run):null;
  const workflow=(run?.contract_snapshot_json as {workflow_input_json?:{material_processing?:{item_id:string};source_goal?:{source_connection_id:string}}})?.workflow_input_json;
  const bound=workflow?.material_processing?.item_id===ctx.item.id || !!ctx.item.connection_id&&workflow?.source_goal?.source_connection_id===ctx.item.connection_id;
  if(v&&v.content_hash===provenance.content_hash&&recorded?.version_id===v.id&&recorded?.content_hash===v.content_hash&&bound)base.result_provenance={version_id:String(v.id),content_hash:String(v.content_hash),version:Number(v.version),run_id:run&&await new (await import('../../runs/repository.js')).PgRunRepository(db).getVisibleRun(identity.spaceId,identity.userId,run.id)?run.id:null};
 }

 if(!canManage)return base;
 try{const api=await (await import('./revisionProvider.js')).revisionProvider(db,identity);base.api_execution={usable:true,name:api.name,reason:null};}catch(e){if(!(e instanceof HttpError))throw e;base.api_execution={usable:false,name:null,reason:e.message};}
 const rewriter=await resolveRevisionMethod(db,identity,ctx.projectId).catch(()=>null);if(rewriter){const v=(await db.query(`SELECT version FROM evolvable_asset_versions WHERE id=$1`,[rewriter.version_id])).rows[0];base.revision_method={version_id:rewriter.version_id,version:Number(v?.version),method:rewriter.text};}
 base.generations=await listReadingGenerations(db,identity,itemId,ctx.projectId,targetKey);
 base.effective_content_hash=base.effective_version_id?(await db.query<{content_hash:string}>(`SELECT content_hash FROM evolvable_asset_versions WHERE id=$1`,[base.effective_version_id])).rows[0]?.content_hash??null:null;
 const versions=await new PromptRepository(db).listVersions(identity,targetKey);
 base.versions=versions.filter(v=>v.scope_type===(ctx.projectId?'project':'space')&&v.scope_id===(ctx.projectId??identity.spaceId)).map(v=>({id:String(v.id),version:Number(v.version),status:String(v.status),content_hash:String(v.content_hash),method:String((v.content as {template?:string})?.template??''),reason:((v.content as {reading_reason?:string})?.reading_reason)??null}));
 base.cases=(await db.query<{id:string;name:string}>(`SELECT id,name,(input_json->>'context_hash'<>$5 OR input_json->>'authority'<>$6) AS stale FROM evaluation_cases WHERE space_id=$1 AND asset_id=$2 AND created_by_user_id=$3 AND status='active' AND input_json->>'reading_item_id'=$4 ORDER BY created_at DESC LIMIT 20`,[identity.spaceId,asset.id,identity.userId,itemId,sha256Json(ctx.context),ctx.authority])).rows;
 const availableCases:typeof base.cases=[];for(const c of base.cases){try{const view=await readReadingSample(db,identity,c.id);availableCases.push({...c,stale:view.stale})}catch(e){if(!(e instanceof HttpError)||![403,404].includes(e.statusCode))throw e;}}base.cases=availableCases;
 const ids=(await db.query<{id:string}>(`SELECT id FROM evolvable_asset_evaluation_runs WHERE space_id=$1 AND asset_id=$2 AND created_by_user_id=$3 AND evaluator_version=$4 AND eval_suite_ref_json->>'item_id'=$5 AND eval_suite_ref_json->>'project_id' IS NOT DISTINCT FROM $6 ORDER BY created_at DESC LIMIT 20`,[identity.spaceId,asset.id,identity.userId,PAIR_EVALUATOR,itemId,ctx.projectId])).rows;
 for(const {id} of ids)base.trials.push(await readReadingTrial(db,identity,id));
 base.promotion=(await db.query<{id:string;status:string;candidate_version_id:string}>(`SELECT p.id,p.status,p.payload_json->>'candidate_version_id' AS candidate_version_id FROM proposals p JOIN evolvable_asset_evaluation_runs e ON e.id=p.payload_json->'evaluation_run_ids'->>0 AND e.space_id=p.space_id WHERE p.space_id=$1 AND p.created_by_user_id=$2 AND p.proposal_type='evolvable_asset_version_promote' AND p.payload_json->>'asset_id'=$3 AND e.evaluator_version=$4 AND e.created_by_user_id=$2 AND e.eval_suite_ref_json->>'item_id'=$5 AND e.eval_suite_ref_json->>'project_id' IS NOT DISTINCT FROM $6 ORDER BY p.created_at DESC LIMIT 1`,[identity.spaceId,identity.userId,asset.id,PAIR_EVALUATOR,itemId,ctx.projectId])).rows[0]??null;
 return base;
}
export async function initializeReading(db:Pool,config:ServerConfig,identity:SpaceUserIdentity){
 // Explicit catalog synchronization, same standing maintenance authority as system assets.
 await assertCanWriteAssetOwnerScope(db,identity,{id:'reading-catalog',space_id:null,owner_scope_type:'system',owner_scope_id:null});
 return withDbTransaction(db,tx=>syncBuiltinPrompts(tx,config.catalogRoot,[READING_METHOD_KEY,REVISION_METHOD_KEY]));
}
export async function saveReadingDraft(db:Pool,identity:SpaceUserIdentity,raw:unknown){
 const parsed=ReadingMethodDraftSchema.safeParse(raw);if(!parsed.success)throw new HttpError(422,parsed.error.message);const input=parsed.data;assertSafeGoalMessage(JSON.stringify(input));
 return withDbTransaction(db,async tx=>{
  const ctx=await readingItemContext(tx,identity,input.item_id,input.project_id);const asset=await readingAsset(tx,identity,true,input.target_key);await lockEvolutionAssets(tx,[asset.id]);
  const current=await freezeReadingMethod(tx,{...identity,projectId:ctx.projectId},ctx.context,input.target_key);
  if(current.frozen.version_id!==input.parent_version_id){const candidate=await (await import('./access.js')).readingCandidate(tx,identity,input.parent_version_id,ctx.projectId,input.target_key);readingStrategy(candidate.version.content);}
  const parent=(await tx.query(`SELECT content_json,status FROM evolvable_asset_versions WHERE id=$1 AND asset_id=$2`,[input.parent_version_id,asset.id])).rows[0];
  const inherited={...(parent.content_json as Record<string,unknown>)};if(['approved','deprecated'].includes(String(parent.status))){delete inherited.reading_generation;delete inherited.reading_change_summary;delete inherited.reading_changes;}
  return new PromptRepository(tx).createVersion(identity,input.target_key??READING_METHOD_KEY,{parent_version_id:input.parent_version_id,scope_type:ctx.projectId?'project':'space',scope_id:ctx.projectId??identity.spaceId,content_json:{...inherited,template:input.method,messages:undefined,reading_reason:input.reason}});
 });
}
export async function saveReadingSample(db:Pool,identity:SpaceUserIdentity,itemId:string,projectId:string|null,raw:unknown,config:ServerConfig,targetKey=READING_METHOD_KEY){
 const parsed=ReadingMethodSampleSchema.safeParse(raw);if(!parsed.success)throw new HttpError(422,parsed.error.message);assertSafeGoalMessage(JSON.stringify(parsed.data));
 return withDbTransaction(db,async tx=>{let ctx=await readingItemContext(tx,identity,itemId,projectId);if(ctx.projectId)await (await import('../../projects/access.js')).lockProjectAudience(tx,identity.spaceId,ctx.projectId);const locked=(await tx.query<{connection_id:string|null}>(`SELECT connection_id FROM source_items WHERE id=$1 AND space_id=$2 FOR SHARE`,[itemId,identity.spaceId])).rows[0];if(locked?.connection_id)await tx.query(`SELECT id FROM source_connections WHERE id=$1 AND space_id=$2 FOR SHARE`,[locked.connection_id,identity.spaceId]);ctx=await readingItemContext(tx,identity,itemId,projectId);const asset=await readingAsset(tx,identity,true,targetKey);const baseline=await freezeReadingMethod(tx,{...identity,projectId:ctx.projectId},ctx.context,targetKey);const proof=await prepareSampleAuthority(tx,config,identity,ctx,parsed.data.pages);
 return new EvaluationHarnessService(tx).createCase(identity,asset.id,{name:parsed.data.name,input_json:{kind:'reading_method_sample.v1',reading_item_id:itemId,project_id:ctx.projectId,authority:ctx.authority,context_hash:sha256Json(ctx.context),pages:parsed.data.pages,authority_proof:proof},baseline_version_id:baseline.frozen.version_id,baseline_output_json:{not_yet_run:true},verification_recipe_json:{checks:[{type:'non_empty',path:'summary'}]}},{trustedReadingSample:true});
 });
}
export async function assertReadingPromotion(db:Queryable,identity:SpaceUserIdentity,versionId:string,evaluationIds:unknown,target?:{type:string;id:string|null}){
 const ids=Array.isArray(evaluationIds)?evaluationIds.filter((i):i is string=>typeof i==='string'):[];
 if(ids.length!==1)throw new HttpError(409,'Choose one completed reading comparison with a human judgment');
 const view=await readReadingTrial(db,identity,ids[0]!);
 readingStrategy((await db.query(`SELECT content_json FROM evolvable_asset_versions WHERE id=$1`,[versionId])).rows[0]?.content_json);
 const reference=(await db.query<{eval_suite_ref_json:{project_id:string|null}}>(`SELECT eval_suite_ref_json FROM evolvable_asset_evaluation_runs WHERE id=$1 AND space_id=$2`,[ids[0],identity.spaceId])).rows[0]?.eval_suite_ref_json;
 if(target&&(!reference||target.type!==(reference.project_id?'project':'space')||target.id!==(reference.project_id??identity.spaceId)))throw new HttpError(409,'Promotion scope must match the compared scope');
 if(view.candidate_version_id!==versionId||view.visibility!=='visible'||view.stale||view.status!=='passed'||!['better','same'].includes(view.judgment??''))throw new HttpError(409,'Reading promotion needs a current authorized comparison and a positive human judgment');
}

export async function readReadingSample(db:Queryable,identity:SpaceUserIdentity,id:string){
 const keyRow=(await db.query(`SELECT a.asset_key FROM evaluation_cases c JOIN evolvable_assets a ON a.id=c.asset_id WHERE c.id=$1 AND c.space_id=$2 AND c.created_by_user_id=$3`,[id,identity.spaceId,identity.userId])).rows[0];
 if(!keyRow||![READING_METHOD_KEY,REVISION_METHOD_KEY].includes(String(keyRow.asset_key)))throw new HttpError(404,'Sample not found');
 const asset=await readingAsset(db,identity,true,String(keyRow.asset_key));
 const sample=(await db.query<{name:string;input_json:{kind:string;reading_item_id:string;project_id:string|null;authority:string;context_hash:string;pages:Array<{url:string;text:string}>}}>(`SELECT name,input_json FROM evaluation_cases WHERE id=$1 AND space_id=$2 AND asset_id=$3 AND created_by_user_id=$4 AND status='active'`,[id,identity.spaceId,asset.id,identity.userId])).rows[0];
 if(!sample||sample.input_json.kind!=='reading_method_sample.v1')throw new HttpError(404,'Reading sample not found');
 const ctx=await readingItemContext(db,identity,sample.input_json.reading_item_id,sample.input_json.project_id);

 await assertSampleAuthority(db,identity,ctx,sample.input_json,false);
 return {name:sample.name,pages:sample.input_json.pages,stale:ctx.authority!==sample.input_json.authority||sha256Json(ctx.context)!==sample.input_json.context_hash||await sampleContentChanged(db,identity.spaceId,sample.input_json)};
}

/** Navigation affordance only. No material reads, audience scans, sync or writes. */
export async function readingEntryScope(db:Queryable,identity:SpaceUserIdentity,projectId:string|null){
 const role=(await db.query(`SELECT role FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active'`,[identity.spaceId,identity.userId])).rows[0]?.role;
 if(!['owner','admin'].includes(String(role)))return {can_manage:false,project_id:projectId};
 if(projectId&&!await canWriteProject(db,identity.spaceId,projectId,identity.userId))return {can_manage:false,project_id:projectId};
 try{await readingAsset(db,identity)}catch(e){if(!(e instanceof HttpError)||e.statusCode!==409)throw e;}
 return {can_manage:true,project_id:projectId};
}

/** Optional execution inventory; only when the person opens CLI selection. No mutation or article read. */
export async function readingCliOptions(db:Queryable,identity:SpaceUserIdentity,projectId:string|null){
 const scope=await readingEntryScope(db,identity,projectId);if(!scope.can_manage)throw new HttpError(403,'Prompt maintenance required');
 const agents=(await db.query<{id:string}>(`SELECT id FROM agents WHERE space_id=$1 AND owner_user_id=$2 AND status='active' ORDER BY id`,[identity.spaceId,identity.userId])).rows;
 const repository=new (await import('../../sessions/conversationBackendRepository.js')).PgConversationBackendRepository(db);
 const options:ReadingMethodContext['runtimes']=[];
 for(const agent of agents)for(const option of await repository.listOptions(identity.spaceId,identity.userId,agent.id)){
  if(option.usable!==false&&option.host_bound&&option.host_id)options.push({agent_id:agent.id,runtime_profile_id:option.runtime_profile_id,name:`${option.runtime_key} · ${option.host_name??option.host_id} · ${option.name}`,usable:true,reason:null});
 }
 return options;
}
