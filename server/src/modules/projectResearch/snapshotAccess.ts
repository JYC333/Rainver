import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {HttpError,objectValue} from '../routeUtils/common.js';
import {researchWorkflowProjection} from './workflowOntology.js';
import {sourceItemFullContentReadClause} from '../sources/sourceItemAccess.js';
import {ContentAccessAuditService} from '../contentAccess/audit.js';
/** A snapshot remains bound to its originating Workflow/Thread even without a problem call. */
export function researchSnapshotWorkflowReadableSql(operation:string,user:string,includeOversight?:boolean):string{
 const projection=researchWorkflowProjection({workflowAlias:'snapshot_workflow',objectAlias:'snapshot_workflow_object',viewerPlaceholder:user,includeOversight});
 return `(COALESCE(${operation}.progress_json->>'run_kind','')<>'synthesis_only' OR EXISTS(SELECT 1 FROM ${projection.from} WHERE snapshot_workflow.object_id=${operation}.progress_json->>'workflow_id' AND snapshot_workflow.space_id=${operation}.space_id AND snapshot_workflow.project_id=${operation}.project_id AND ${projection.visibilityPredicate}))`;
}
export async function assertResearchSnapshotContentReadable(db:Queryable,identity:SpaceUserIdentity,projectId:string,raw:unknown):Promise<void>{
 const state=objectValue(raw);if(state.run_kind!=='synthesis_only')return;
 const projection=researchWorkflowProjection({viewerPlaceholder:'$4'}),workflow=typeof state.workflow_id==='string'?state.workflow_id:null;
 const row=(await db.query<{id:string;primary_thread_id:string|null}>(`SELECT w.object_id AS id,pin.primary_thread_id FROM ${projection.from} WHERE w.object_id=$1 AND w.space_id=$2 AND w.project_id=$3 AND ${projection.visibilityPredicate}`,[workflow,identity.spaceId,projectId,identity.userId])).rows[0];
 if(!row)throw new HttpError(404,'Research snapshot not found');
 const sources=[...new Set(Array.isArray(state.source_item_ids)?state.source_item_ids.filter((id):id is string=>typeof id==='string'):[])];
 if(sources.length&&(await db.query(`SELECT item.id FROM source_items item WHERE item.space_id=$1 AND item.id=ANY($2::varchar[]) AND item.deleted_at IS NULL AND ${sourceItemFullContentReadClause('item','$3')}`,[identity.spaceId,sources,identity.userId])).rows.length!==sources.length)throw new HttpError(404,'Research snapshot not found');
 try{const audit=new ContentAccessAuditService(db);await audit.recordReads({spaceId:identity.spaceId,viewerUserId:identity.userId,resourceType:'space_object',resourceIds:[row.id,...(row.primary_thread_id?[row.primary_thread_id]:[])],accessType:'research_snapshot_read'});await audit.recordReads({spaceId:identity.spaceId,viewerUserId:identity.userId,resourceType:'source_item',resourceIds:sources,accessType:'research_snapshot_read'});}catch{throw new HttpError(503,'Research snapshot content-read audit unavailable');}
}
