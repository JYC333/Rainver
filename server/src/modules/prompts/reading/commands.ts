import {HttpError,withDbTransaction,type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {lockEvolutionAssets} from '../../evolution/assetLocks.js';
import {PromptRepository} from '../repository.js';
import {resolvePrompt} from '../resolver.js';
import {readingAsset} from './access.js';
import {READING_METHOD_KEY} from './runtime.js';
import {assertReadingPromotion} from './workspace.js';
import {readingItemContext} from '../../sources/index.js';

/** Same proposal/applier as every prompt; retries of this explicit request reuse its pending proposal. */
export async function proposeReadingMethod(db:Pool,identity:SpaceUserIdentity,versionId:string,evaluationId:string,projectId:string|null){
 return withDbTransaction(db,async tx=>{
  const key=(await tx.query(`SELECT a.asset_key FROM evolvable_assets a JOIN evolvable_asset_versions v ON v.asset_id=a.id WHERE v.id=$1 AND a.asset_key IN ('reading.project_investigation','prompt.revision.method')`,[versionId])).rows[0]?.asset_key;if(!key)throw new HttpError(404,'Method not found');const asset=await readingAsset(tx,identity,true,String(key));await lockEvolutionAssets(tx,[asset.id]);
  const target={type:projectId?'project':'space',id:projectId??identity.spaceId};
  await assertReadingPromotion(tx,identity,versionId,[evaluationId],target);
  const prior=(await tx.query<{id:string}>(`SELECT id FROM proposals WHERE space_id=$1 AND proposal_type='evolvable_asset_version_promote' AND status='pending' AND created_by_user_id=$2 AND payload_json->>'asset_id'=$3 AND payload_json->>'candidate_version_id'=$4 AND payload_json->>'target_scope_type'=$5 AND payload_json->>'target_scope_id'=$6 AND payload_json->'evaluation_run_ids'=$7::jsonb ORDER BY created_at DESC LIMIT 1`,[identity.spaceId,identity.userId,asset.id,versionId,target.type,target.id,JSON.stringify([evaluationId])])).rows[0];
  if(prior)return {proposal_id:prior.id};
  return new PromptRepository(tx).createPromotionProposal(identity,String(key),{version_id:versionId,evaluation_run_ids:[evaluationId],scope_type:target.type,scope_id:target.id,reason:'Human-reviewed reading method comparison',label:'production'});
 });
}
/** Resolving the expected effective version and rollback write share the canonical asset lock. */
export async function rollbackReadingMethod(db:Pool,identity:SpaceUserIdentity,itemId:string,projectId:string|null,expectedVersionId:string,targetKey=READING_METHOD_KEY){
 return withDbTransaction(db,async tx=>{
  const ctx=await readingItemContext(tx,identity,itemId,projectId);const asset=await readingAsset(tx,identity,true,targetKey);await lockEvolutionAssets(tx,[asset.id]);
  const effective=await resolvePrompt(tx,{...identity,assetKey:targetKey,projectId:ctx.projectId});
  if(effective.version_id!==expectedVersionId)throw new HttpError(409,'Effective method changed; refresh before rollback');
  return new PromptRepository(tx).rollbackDeployment(identity,targetKey,{scope_type:ctx.projectId?'project':'space',scope_id:ctx.projectId??identity.spaceId,label:'production'});
 });
}
