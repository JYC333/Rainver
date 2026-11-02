import {explicitRunTimeLimit} from '../../runs/runTimeLimit.js';
import {goalCollectionReadableSql} from '../goals/itemVisibility.js';
import {randomUUID} from 'node:crypto';
import {PROJECT_DEEP_READING_LIMITS,ProjectDeepReadRequestSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {readingProjectContext} from '../readingMethods/context.js';
import {MaterialItemProcessingService} from '../materialProcessing/items.js';
import {projectMaterialRowsSql} from '../readingMaterial.js';
import {sourceItemFullContentReadClause,sourceDerivedArtifactReadableClause} from '../sourceItemAccess.js';
import {deepReadOf,assertDeepReadingAccess} from './contract.js';
import {PgRunRepository,type RunRecord} from '../../runs/repository.js';
async function assertFavoriteMaterial(db:Pool,identity:SpaceUserIdentity,projectId:string,itemId:string){
 await readingProjectContext(db,identity,projectId);
 if(!(await db.query(`SELECT i.id FROM source_items i WHERE i.space_id=$1 AND i.id=$2 AND i.deleted_at IS NULL AND ${sourceItemFullContentReadClause('i','$3')}`,[identity.spaceId,itemId,identity.userId])).rows.length)throw new HttpError(404,'Project material not found');
 if(!(await db.query(`SELECT 1 FROM (${projectMaterialRowsSql('$1','$2')} UNION ALL SELECT gi.source_item_id,'following',gi.id,g.project_id FROM source_goal_items gi JOIN source_goals g ON g.id=gi.goal_id AND g.space_id=gi.space_id WHERE gi.space_id=$1 AND g.project_id=$2 AND g.status<>'deleted' AND gi.selection_status<>'not_selected' AND ${goalCollectionReadableSql('gi','$4','gi.associated_at')}) membership WHERE source_item_id=$3 LIMIT 1`,[identity.spaceId,projectId,itemId,identity.userId])).rows.length)throw new HttpError(404,'Project material not found');
}
export async function favoriteStatus(db:Pool,identity:SpaceUserIdentity,projectId:string,itemId:string){
 await assertFavoriteMaterial(db,identity,projectId,itemId);return {item_id:itemId,favorite:(await db.query<{favorite:boolean}>('SELECT favorite FROM source_item_user_states WHERE space_id=$1 AND source_item_id=$2 AND user_id=$3',[identity.spaceId,itemId,identity.userId])).rows[0]?.favorite??false};
}
export async function favoriteMaterial(db:Pool,identity:SpaceUserIdentity,projectId:string,itemId:string,favorite:boolean){
 await assertFavoriteMaterial(db,identity,projectId,itemId);
 await db.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,favorite,created_at,updated_at) VALUES($1,$2,$3,$4,$5,now(),now()) ON CONFLICT(space_id,source_item_id,user_id) DO UPDATE SET favorite=excluded.favorite,updated_at=now()`,[randomUUID(),identity.spaceId,itemId,identity.userId,favorite]);return {item_id:itemId,favorite};
}
export async function favoriteList(db:Pool,identity:SpaceUserIdentity,projectId:string,offset=0){
 await readingProjectContext(db,identity,projectId);
 if(!Number.isInteger(offset)||offset<0||offset>10000)throw new HttpError(422,'Invalid offset');
 const rows=(await db.query(`SELECT i.id AS item_id,i.title,i.source_uri FROM source_item_user_states s JOIN source_items i ON i.id=s.source_item_id AND i.space_id=s.space_id WHERE s.space_id=$1 AND s.user_id=$2 AND s.favorite AND i.deleted_at IS NULL AND ${sourceItemFullContentReadClause('i','$2')} AND (EXISTS(SELECT 1 FROM (${projectMaterialRowsSql('$1','$3')}) membership WHERE membership.source_item_id=i.id) OR EXISTS(SELECT 1 FROM source_goal_items gi JOIN source_goals g ON g.id=gi.goal_id AND g.space_id=gi.space_id WHERE gi.space_id=i.space_id AND gi.source_item_id=i.id AND g.project_id=$3 AND g.status<>'deleted' AND gi.selection_status<>'not_selected' AND ${goalCollectionReadableSql('gi','$2','gi.associated_at')})) ORDER BY s.updated_at DESC,i.id LIMIT 26 OFFSET $4`,[identity.spaceId,identity.userId,projectId,offset])).rows;
 return {items:rows.slice(0,25),next_offset:rows.length>25&&offset+25<=10000?offset+25:null};
}
export async function startDeepReading(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,projectId:string,itemId:string,raw:unknown){
 const input=ProjectDeepReadRequestSchema.parse(raw);
 if(input.following&&!(await db.query("SELECT id FROM source_goals WHERE space_id=$1 AND project_id=$2 AND id=$3 AND active_version_id=$4 AND status='running'",[identity.spaceId,projectId,input.following.goal_id,input.following.version_id])).rows.length)throw new HttpError(409,'Select an active confirmed Following purpose');
 await readingProjectContext(db,identity,projectId);
 return new MaterialItemProcessingService(db,config).start(identity,itemId,{...input,investigation:true,deep_read:{project_id:projectId,following:input.following,rerun:!!input.rerun_of,rerun_of:input.rerun_of,retry_of:input.retry_of}});
}
export async function readDeepOperations(db:Pool,identity:SpaceUserIdentity,projectId:string,id?:string,offset=0){
 await readingProjectContext(db,identity,projectId);
 if(!Number.isInteger(offset)||offset<0||offset>10000)throw new HttpError(422,'Invalid offset');
 const rows=(await db.query<{id:string;source_item_id:string;material_title:string|null;material_purpose:string|null;metadata_json:{run_id:string;generation:number;session_config?:import('@rainver/protocol').RuntimeSessionConfigSelection[]};status:string;error_code:string|null;created_at:string}>(`SELECT e.*,(SELECT i.title FROM source_items i WHERE i.id=e.source_item_id AND i.space_id=e.space_id) AS material_title,(SELECT left(COALESCE(v.plan_json->'intent_snapshot'->>'intent',v.plan_json->>'summary'),200) FROM runs r JOIN source_goal_versions v ON v.space_id=r.space_id AND v.id=r.contract_snapshot_json->'workflow_input_json'->'deep_read'->'following'->>'version_id' AND v.goal_id=r.contract_snapshot_json->'workflow_input_json'->'deep_read'->'following'->>'goal_id' WHERE r.space_id=e.space_id AND r.id=e.metadata_json->>'run_id') AS material_purpose FROM extraction_jobs e WHERE space_id=$1 AND metadata_json->>'user_id'=$2 AND metadata_json->>'deep_project'=$3 ${id?'AND id=$4':' '} ORDER BY created_at DESC,id DESC LIMIT 26 ${id?'':'OFFSET $4'}`,[identity.spaceId,identity.userId,projectId,id??offset])).rows;
 if(id&&!rows.length)throw new HttpError(404,'Deep reading operation not found');
 const items=[];
 for(const row of rows.slice(0,25)){
  const run=await new PgRunRepository(db).getRun(identity.spaceId,row.metadata_json.run_id);let withheld=!run||!deepReadOf(run),source_configuration_changed:boolean|null=null;
  if(run)try{source_configuration_changed=(await assertDeepReadingAccess(db,run))?.source_configuration_changed??false;}catch(e){if(e instanceof HttpError&&[403,404,409,422].includes(e.statusCode))withheld=true;else throw e;}
  const report=!withheld?(await db.query<{id:string;artifact_id:string;original_snapshot_id:string|null}>(`SELECT s.id,s.artifact_id,s.original_snapshot_id FROM source_snapshots s JOIN artifacts a ON a.id=s.artifact_id AND a.space_id=s.space_id WHERE s.space_id=$1 AND s.origin_run_id=$2 AND s.owner_user_id=$3 AND s.reading_role='analysis' AND ${sourceDerivedArtifactReadableClause('a','$3',true)} LIMIT 1`,[identity.spaceId,run!.id,identity.userId])).rows[0]:null;
  items.push({purpose_label:withheld?null:row.material_purpose?.slice(0,200)??null,title:withheld?null:row.material_title?.slice(0,512)??null,execution:!withheld&&run?.agent_id&&run.requested_runtime_profile_id?{agent_id:run.agent_id,runtime_profile_id:run.requested_runtime_profile_id,session_config:row.metadata_json.session_config??[]}:null,id:row.id,item_id:row.source_item_id,run_id:row.metadata_json.run_id,project_id:projectId,status:row.status==='succeeded'?'completed':row.status==='failed'?row.error_code==='source_material_cancelled'?'cancelled':'failed':run&&['succeeded','degraded','failed','cancelled','orphaned'].includes(run.status)?'settling':run?.status??'queued',withheld,source_configuration_changed:withheld?null:source_configuration_changed,error:withheld?null:row.error_code,report:report?{snapshot_id:report.id,artifact_id:report.artifact_id,original_snapshot_id:report.original_snapshot_id}:null,created_at:new Date(row.created_at).toISOString(),generation:row.metadata_json.generation,original:!withheld&&run&&deepReadOf(run)?.original?{snapshot_id:deepReadOf(run)!.original!.snapshot_id,artifact_id:deepReadOf(run)!.original!.artifact_id,content_hash:deepReadOf(run)!.original!.content_hash}:null,following:!withheld&&run?deepReadOf(run)?.following??null:null,purpose_version_id:!withheld&&run?deepReadOf(run)?.following?.version_id??null:null,method_version_id:!withheld&&run?(run.contract_snapshot_json as {workflow_input_json?:{reading_method?:{version_id:string}}})?.workflow_input_json?.reading_method?.version_id??null:null,effective_run_seconds:!withheld&&run?(explicitRunTimeLimit(run.contract_snapshot_json,null)?.ms??0)/1000||null:null});
 }
 return {items,next_offset:!id&&rows.length>25&&offset+25<=10000?offset+25:null,limits:PROJECT_DEEP_READING_LIMITS};
}
export async function cancelDeepReading(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,projectId:string,id:string){
 // Cancellation needs ownership, not access to the withdrawn input or report.
 const operation=(await db.query<{metadata_json:{run_id:string}}>("SELECT metadata_json FROM extraction_jobs WHERE id=$1 AND space_id=$2 AND metadata_json->>'user_id'=$3 AND metadata_json->>'deep_project'=$4",[id,identity.spaceId,identity.userId,projectId])).rows[0];if(!operation)throw new HttpError(404,'Deep reading operation not found');
 const {buildRunOrchestration}=await import('../../runs/orchestrationFactory.js');await buildRunOrchestration(config).orchestration.cancelRun({run_id:operation.metadata_json.run_id,space_id:identity.spaceId,requested_by_user_id:identity.userId,reason:'Private deep reading cancelled by owner'});
 const run=(await db.query<RunRecord>('SELECT * FROM runs WHERE id=$1 AND space_id=$2',[operation.metadata_json.run_id,identity.spaceId])).rows[0];if(run&&['succeeded','degraded','failed','cancelled','orphaned'].includes(run.status))await new MaterialItemProcessingService(db,config).reconcileTerminal(run.id);
 return {id,status:run?.status??'queued'};
}

/** Explicit choices for one authorized material, not private per-member activity. */
export async function deepReadingPurposes(db:Pool,identity:SpaceUserIdentity,projectId:string,itemId:string){
 await readingProjectContext(db,identity,projectId);
 const {requireProcessingItem}=await import('../materialProcessing/items.js');const {item}=await requireProcessingItem(db,identity,itemId,false);
 if(item.project_id&&item.project_id!==projectId)throw new HttpError(404,'Project material not found');
 const rows=(await db.query<{goal_id:string;version_id:string;connection_id:string;label:string}>(`SELECT DISTINCT g.id AS goal_id,g.active_version_id AS version_id,i.source_connection_id AS connection_id,left(COALESCE(g.compatibility_json->>'display_title',g.intent_json->>'intent',''),200) AS label FROM source_goals g JOIN source_goal_items i ON i.goal_id=g.id AND i.space_id=g.space_id WHERE g.space_id=$1 AND g.project_id=$2 AND g.status='running' AND g.active_version_id IS NOT NULL AND i.source_item_id=$3 AND i.selection_status<>'not_selected' ORDER BY g.id,i.source_connection_id LIMIT 101`,[identity.spaceId,projectId,itemId])).rows;
 const {deepReadingContext}=await import('./contract.js');const choices=[];
 for(const row of rows.slice(0,100)){try{await deepReadingContext(db,identity,projectId,itemId,row);choices.push({...row,label:row.label.slice(0,200)})}catch(e){if(!(e instanceof HttpError&&[403,404].includes(e.statusCode)))throw e;}}
 return {choices,truncated:rows.length>100};
}
