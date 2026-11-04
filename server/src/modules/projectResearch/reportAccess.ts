import {assertProblemReferences} from '../inquiry/problemReferences.js';
import {ResearchCallSchema} from '@rainver/protocol';
import {researchMetadataReadableSql} from './researchOperationMetadata.js';
import {projectReadAccessSql} from '../access/contentAccessSql.js';
import {researchArtifactOriginSql} from './researchArtifactAccess.js';
import {assertResearchCallReadable,assertResearchCallSourceDependencies,ResearchCallContentUnavailable} from './researchCallAccess.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
/** Shared report/Reader content gate; old unbound reports keep their existing domain gates. */
export async function assertResearchReportCallReadable(db:Queryable,identity:SpaceUserIdentity,project:string,operation:string):Promise<void>{
 const op=(await db.query<{research_call_json:unknown;progress_json:unknown}>(`SELECT research_call_json,progress_json FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3`,[operation,identity.spaceId,project])).rows[0];
 if(!op)throw new HttpError(404,'Research report not found or not accessible');
 await assertResearchCallReadable(db,identity,project,op.research_call_json,op.progress_json);
}

export interface ResearchArtifactOrigin {
 id:string;project_id:string;research_call_json:unknown;progress_json:unknown;metadata_readable:boolean;direct_origin:boolean;
}
/** Full content check for all bound origins, including input artifact dependencies. */
export async function assertResearchArtifactReadable(db:Queryable,identity:SpaceUserIdentity,artifactId:string|readonly string[]):Promise<readonly ResearchArtifactOrigin[]>{
 const roots=typeof artifactId==='string'?[artifactId]:[...artifactId];
 // UNION deduplicates cycles; the outer unsorted LIMIT stops recursive demand
 // at the one extra identity needed to diagnose the 200-artifact boundary.
 const graph=await db.query<{id:string}>(`WITH RECURSIVE dependencies(id) AS (
   SELECT unnest($1::text[])
   UNION
   SELECT ref->>'id' FROM dependencies d
   JOIN artifacts dependency_artifact ON dependency_artifact.id=d.id AND dependency_artifact.space_id=$2
   JOIN project_operations dependency_operation ON ${researchArtifactOriginSql('dependency_artifact','dependency_operation')} AND dependency_operation.research_call_json IS NOT NULL
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(dependency_operation.research_call_json->'input_refs')='array' THEN dependency_operation.research_call_json->'input_refs' ELSE '[]'::jsonb END) ref
   WHERE ref->>'type'='artifact' AND ref->>'id' IS NOT NULL
 ) SELECT id FROM dependencies LIMIT 201`,[roots,identity.spaceId]);
 const ids=graph.rows.map(r=>r.id);
 const origins=await db.query<ResearchArtifactOrigin>(`SELECT op.id,op.project_id,op.research_call_json,op.progress_json,
 bool_or(origin_artifact.id=ANY($4::text[])) AS direct_origin,
 (${projectReadAccessSql('op.space_id','op.project_id','$3')} AND ${researchMetadataReadableSql('op','$3')}) AS metadata_readable
 FROM artifacts origin_artifact JOIN project_operations op ON ${researchArtifactOriginSql('origin_artifact','op')}
 WHERE origin_artifact.id=ANY($1::text[]) AND origin_artifact.space_id=$2 AND op.research_call_json IS NOT NULL GROUP BY op.id`,[ids,identity.spaceId,identity.userId,roots]);
 // Check authority before exposing a dependency-limit diagnostic. Content checks
 // reuse the ordinary call gate's dependencies; no cached grants or new ACL.
 // Preflight every binding and every direct origin before considering a
 // dependency downgrade: SQL row order must never weaken root authority.
 for(const origin of origins.rows){
   if(!ResearchCallSchema.safeParse(origin.research_call_json).success)throw new HttpError(409,'Research call binding requires reconciliation');
 }
 for(const origin of origins.rows){
   if(origin.direct_origin&&!origin.metadata_readable)throw new HttpError(404,'Research call not found');
 }
 for(const origin of origins.rows.filter(origin=>origin.direct_origin)){
   const call=ResearchCallSchema.parse(origin.research_call_json);
   try{await assertResearchCallSourceDependencies(db,identity,call,origin.progress_json);}
   catch(error){if(error instanceof ResearchCallContentUnavailable)throw new HttpError(404,'Research call not found');throw error;}
 }
 const references=new Map<string,Map<string,{type:"note"|"task"|"artifact"|"inquiry_thread";id:string}>>();
 for(const origin of origins.rows){
   const parsed=ResearchCallSchema.safeParse(origin.research_call_json);
   if(!parsed.success)throw new HttpError(409,'Research call binding requires reconciliation');
   if(!origin.metadata_readable)throw new ResearchCallContentUnavailable();
   const group=references.get(origin.project_id)??new Map();
   for(const ref of parsed.data.input_refs)group.set(`${ref.type}:${ref.id}`,ref);
   references.set(origin.project_id,group);
   if(!origin.direct_origin)await assertResearchCallSourceDependencies(db,identity,parsed.data,origin.progress_json);
 }
 for(const [project,group] of references){
   const refs=[...group.values()];
   for(let offset=0;offset<refs.length;offset+=40){
     try{await assertProblemReferences(db,identity,project,refs.slice(offset,offset+40));}
     catch(error){if(error instanceof HttpError&&error.statusCode===404)throw new ResearchCallContentUnavailable();throw error;}
   }
 }
 if(ids.length>200)throw new HttpError(409,'Research artifact dependencies require reconciliation');
 return origins.rows;
}
