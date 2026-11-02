import type {SourceConnectionRow} from '../sourceRepositoryRows.js';
import type {RunRecord} from '../../runs/repository.js';
import type {OriginalVersion} from '../retainedOriginals.js';
import type {ReadingFollowingRef} from '../readingMethods/followingContext.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {readingProjectContext,assertReadingAudience,assertReadingRunEgress} from '../readingMethods/context.js';
import {sourceDerivedArtifactReadableClause,sourceItemFullContentReadClause} from '../sourceItemAccess.js';
import {contentAccessLevelSql,contentReadSql} from '../../access/contentAccessSql.js';
import {contentResourceDefinition} from '../../access/contentAccessRegistry.js';
import {sharedOriginalVersions} from '../retainedOriginals.js';
import {agentReadingPolicy} from '../materialProcessing/policy.js';
export interface DeepReadInput {project_id:string;following?:ReadingFollowingRef|null;rerun?:boolean;rerun_of?:string;retry_of?:string}
export interface DeepReadContract {project_id:string;original:OriginalVersion|null;authority:string;input_key:string;generation:number;following:ReadingFollowingRef|null}
export function deepReadOf(run:Pick<RunRecord,'contract_snapshot_json'>):DeepReadContract|null{return (run.contract_snapshot_json as {workflow_input_json?:{deep_read?:DeepReadContract}})?.workflow_input_json?.deep_read??null;}
export async function deepReadingContext(db:Queryable,identity:SpaceUserIdentity,projectId:string,itemId:string,ref?:ReadingFollowingRef|null){
 const project=await readingProjectContext(db,identity,projectId);let following:unknown=null;
 if(ref){
  const row=(await db.query<{plan_json:{summary:string;analysis_brief?:string;intent_snapshot?:unknown}}>(`SELECT v.plan_json FROM source_goals g JOIN source_goal_versions v ON v.space_id=g.space_id AND v.goal_id=g.id AND v.id=$4 WHERE g.space_id=$1 AND g.project_id=$2 AND g.id=$3 AND g.status<>'deleted' AND EXISTS(SELECT 1 FROM source_goal_items i WHERE i.space_id=g.space_id AND i.goal_id=g.id AND i.source_item_id=$5 AND i.source_connection_id=$6 AND i.selection_status<>'not_selected')`,[identity.spaceId,projectId,ref.goal_id,ref.version_id,itemId,ref.connection_id])).rows[0];
  if(!row)throw new HttpError(404,'Following purpose not available for this material');
  await assertReadingAudience(db,identity,null,null,ref.connection_id);
  const source=(await db.query<Pick<SourceConnectionRow,'capture_policy'|'policy_json'>>('SELECT capture_policy,policy_json FROM source_connections WHERE space_id=$1 AND id=$2',[identity.spaceId,ref.connection_id])).rows[0];if(!source||!agentReadingPolicy(source).content)throw new HttpError(403,'Following Source does not allow retained analysis');
  following={goal_id:ref.goal_id,version_id:ref.version_id,intent:row.plan_json.intent_snapshot??row.plan_json.summary,analysis_brief:row.plan_json.analysis_brief??null};
 }
 return following?{project,following}:project;
}
export async function assertDeepReadingAccess(db:Queryable,run:RunRecord){
 const deep=deepReadOf(run);if(!deep)return;
 const identity={spaceId:run.space_id,userId:run.instructed_by_user_id!};
 const {requireProcessingItem,materialAuthority,materialItemContext}=await import('../materialProcessing/items.js');
 const id=materialItemContext(run)?.item_id;if(!id)throw new HttpError(403,'Deep reading identity missing');
 const {item,source}=await requireProcessingItem(db,identity,id,false);
 if(!run.instructed_by_user_id||!deep.authority||run.project_id!==deep.project_id||item.project_id&&item.project_id!==deep.project_id)throw new HttpError(403,'Deep reading authority changed');
 if(source&&!agentReadingPolicy(source).content)throw new HttpError(403,'Source retention does not allow a report');
 await deepReadingContext(db,identity,deep.project_id,id,deep.following);
 await assertReadingAudience(db,identity,null,item.id,item.connection_id);await assertReadingRunEgress(db,run,item.connection_id);
 if(deep.following)await assertReadingRunEgress(db,run,deep.following.connection_id);
 const operation=(await db.query<{metadata_json:{investigation?:{refs?:Array<{item_id:string;artifact_id:string}>}}}>("SELECT metadata_json FROM extraction_jobs WHERE metadata_json->>'run_id'=$1 AND space_id=$2",[run.id,run.space_id])).rows[0];
 for(const ref of operation?.metadata_json.investigation?.refs??[]){
  const allowed=(await db.query<{connection_id:string|null}>(`SELECT i.connection_id FROM source_items i JOIN artifacts a ON a.space_id=i.space_id AND a.id=$3 WHERE i.space_id=$1 AND i.id=$2 AND i.deleted_at IS NULL AND ${sourceItemFullContentReadClause('i','$4')} AND ${contentReadSql('artifact','a','$4',{includeOversight:false})} AND ${contentAccessLevelSql({definition:contentResourceDefinition('artifact')!,alias:'a',userExpr:'$4',includeOversight:false})}='full' AND ${sourceDerivedArtifactReadableClause('a','$4',true)}`,[run.space_id,ref.item_id,ref.artifact_id,identity.userId])).rows[0];
  if(!allowed)throw new HttpError(403,'Historical reading dependency no longer readable');await assertReadingRunEgress(db,run,allowed.connection_id);
 }
 const report=(await db.query<{allowed:boolean}>(`SELECT ${sourceDerivedArtifactReadableClause('a','$3',true)} AS allowed FROM source_snapshots s JOIN artifacts a ON a.space_id=s.space_id AND a.id=s.artifact_id WHERE s.space_id=$1 AND s.origin_run_id=$2 AND s.reading_role='analysis'`,[run.space_id,run.id,identity.userId])).rows;
 if(report.some(r=>!r.allowed))throw new HttpError(403,'Published report dependency withdrawn');
 if(deep.original){const original=(await sharedOriginalVersions(db,run.space_id,[identity.userId],{snapshotIds:[deep.original.snapshot_id],includeText:false})).find(o=>o.item_id===id&&o.artifact_id===deep.original!.artifact_id&&o.content_hash===deep.original!.content_hash);if(!original)throw new HttpError(403,'Frozen original no longer readable');}
 // Equality is an execution freshness rule, enforced separately by
 // assertItemProcessingDispatch before dispatch/submission/settlement. Reads
 // above instead require every live permission and exact retained dependency;
 // a grant to another reader must not erase this owner's authorized history.
 return {source_configuration_changed:deep.authority!==materialAuthority({...item,content_hash:null},source)};
}
