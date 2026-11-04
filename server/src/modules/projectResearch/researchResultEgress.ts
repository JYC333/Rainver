import {assertResearchArtifactReadable} from './reportAccess.js';
import { HttpError,objectValue,type Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";
import { assertReadingRunEgress } from "../sources/index.js";
import { loadSourceConnectionIdsForTargets,sourceConnectionIdsFromMetadata } from "../retrieval/sourcePolicy.js";
import { researchReportReferences } from "./reportReferenceResolver.js";
/** A person's read entitlement is not permission to copy Sources into a model.
 * Resolve original provenance and use the Run's fixed destination owner gate. */
export async function assertResearchResultRunEgress(db:Queryable,run:RunRecord,operationId:string):Promise<void>{
 const result=await db.query<{progress_json:unknown;research_call_json:unknown}>(`SELECT progress_json,research_call_json FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3`,[operationId,run.space_id,run.project_id]);
 if(!result.rows[0])throw new HttpError(404,"Research result not found");
 const root=result.rows[0]!;
 const call=objectValue(root.research_call_json);
 const refs=Array.isArray(call.input_refs)?call.input_refs.map(objectValue):[];
 const inputs=refs.filter(ref=>ref.type==='artifact'&&typeof ref.id==='string').map(ref=>String(ref.id));
 const userId=run.instructed_by_user_id??run.owner_user_id;
 if(inputs.length&&!userId)throw new HttpError(403,'Research egress requires a content reader');
 const origins=inputs.length?await assertResearchArtifactReadable(db,{spaceId:run.space_id,userId:userId!},inputs):[];
 const seen=new Set<string>();
 for(const operation of [{id:operationId,...root},...origins]){
   if(seen.has(operation.id))continue;seen.add(operation.id);
   await assertOperationSourceEgress(db,run,operation.id,operation);
 }
}
/** Same existing per-operation Source/target-owner policy, applied once per proven origin. */
async function assertOperationSourceEgress(db:Queryable,run:RunRecord,operationId:string,operation:{progress_json:unknown;research_call_json:unknown}):Promise<void>{
 const state=objectValue(operation.progress_json),call=objectValue(operation.research_call_json),scope=objectValue(call.scope);
 const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((x):x is string=>typeof x==='string'):[];
 const items=new Set(strings(state.source_item_ids));const evidence=new Set<string>();const connections=new Set<string>();
 const reports=await db.query<{content_json:unknown;archive_artifact_id:string}>(`SELECT content_json,archive_artifact_id FROM project_research_reports WHERE operation_id=$1 AND space_id=$2 ORDER BY created_at,id LIMIT 20`,[operationId,run.space_id]);
 for(const report of reports.rows)for(const ref of researchReportReferences(objectValue(report.content_json))){if(typeof ref.source_item_id==='string')items.add(ref.source_item_id);if(typeof ref.evidence_id==='string')evidence.add(ref.evidence_id);}
 const sources=await db.query<{id:string|null}>(`SELECT connection_id AS id FROM source_items WHERE space_id=$1 AND id=ANY($2::varchar[]) UNION SELECT COALESCE(si.connection_id,ss.connection_id) AS id FROM extracted_evidence e LEFT JOIN source_items si ON si.id=COALESCE(e.source_item_id,e.origin_source_item_id) AND si.space_id=e.space_id LEFT JOIN source_snapshots ss ON ss.id=e.source_snapshot_id AND ss.space_id=e.space_id WHERE e.space_id=$1 AND e.id=ANY($3::varchar[]) UNION SELECT source_connection_id FROM source_channels WHERE space_id=$1 AND id=ANY($4::varchar[])`,[run.space_id,[...items],[...evidence],[...strings(state.channel_ids),...strings(scope.source_channel_ids)]]);
 for(const row of sources.rows)if(row.id)connections.add(row.id);
 const refs=Array.isArray(call.input_refs)?call.input_refs.map(objectValue):[];
 for(const type of ['artifact','note','task']){
  const ids=refs.filter(r=>r.type===type).map(r=>String(r.id));
  const map=await loadSourceConnectionIdsForTargets(db,run.space_id,type,ids);
  for(const values of map.values())for(const id of values)connections.add(id);
 }
 const artifacts=[...reports.rows.map(r=>r.archive_artifact_id),...strings(state.artifact_ids),...refs.filter(r=>r.type==='artifact').map(r=>String(r.id))];
 if(artifacts.length){
  const metadata=await db.query<{metadata_json:unknown}>(`SELECT metadata_json FROM artifacts WHERE space_id=$1 AND id=ANY($2::varchar[])`,[run.space_id,artifacts]);
  for(const row of metadata.rows)for(const id of sourceConnectionIdsFromMetadata(row.metadata_json))connections.add(id);
  const origins=await db.query<{connection_id:string|null}>(`SELECT connection_id FROM source_items WHERE space_id=$1 AND extracted_artifact_id=ANY($2::varchar[])`,[run.space_id,artifacts]);
  for(const row of origins.rows)if(row.connection_id)connections.add(row.connection_id);
 }
 for(const connection of connections)await assertReadingRunEgress(db,run,connection);
}
