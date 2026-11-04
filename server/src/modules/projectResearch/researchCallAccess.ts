import {assertResearchArtifactReadable} from './reportAccess.js';
import { sourceItemFullContentReadClause } from "../sources/sourceItemAccess.js";
import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { runInheritedReadSql } from "../access/contentAccessSql.js";
import { ResearchCallSchema, type ResearchCall } from "@rainver/protocol";
import { HttpError, objectValue, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectReadable } from "../projects/access.js";
import { assertThreadReadable } from "../inquiry/threadAccess.js";
import { assertProblemReferences } from "../inquiry/problemReferences.js";
/** Only content dependencies may degrade an otherwise authorized call to metadata. */
export class ResearchCallContentUnavailable extends HttpError {
 constructor(){super(404,"Research call not found");}
}
export async function assertResearchCallReadable(db:Queryable,identity:SpaceUserIdentity,projectId:string,raw:unknown,progress?:unknown,mode?:"stop"):Promise<ResearchCall|null>{
 if(raw==null)return null;
 const parsed=ResearchCallSchema.safeParse(raw);
 if(!parsed.success)throw new HttpError(409,"Research call binding requires reconciliation");
 await assertProjectReadable(db,identity.spaceId,projectId,identity.userId);
 await assertThreadReadable(db,identity,projectId,parsed.data.thread_id,"read_content");
 const run=await db.query<{allowed:boolean}>(`SELECT ${runInheritedReadSql("$1::varchar","$2::varchar","$3::varchar")} AS allowed`,[parsed.data.requested_by_run_id,identity.spaceId,identity.userId]);
 if(!run.rows[0]?.allowed)throw new HttpError(404,"Research call not found");
 if(mode==="stop")return parsed.data; // Stopping executes no Source content and must survive its withdrawal.
 await assertResearchCallContentDependencies(db,identity,projectId,parsed.data,progress);
 const artifacts=parsed.data.input_refs.filter(ref=>ref.type==='artifact').map(ref=>ref.id);
 if(artifacts.length){try{await assertResearchArtifactReadable(db,identity,artifacts);}catch(error){if(error instanceof HttpError&&error.statusCode===404)throw new ResearchCallContentUnavailable();throw error;}}

 return parsed.data;
}

/** Content-only half: callers must first validate call identity and Project/Thread/Run metadata.
 * The artifact walker uses the canonical SQL metadata gate in its origin query,
 * then these same checks with references batched under their owning Project. */
export async function assertResearchCallContentDependencies(db:Queryable,identity:SpaceUserIdentity,projectId:string,call:ResearchCall,progress?:unknown):Promise<void>{
 try{await assertProblemReferences(db,identity,projectId,call.input_refs);}
 catch(error){if(error instanceof HttpError && error.statusCode===404)throw new ResearchCallContentUnavailable();throw error;}
 await assertResearchCallSourceDependencies(db,identity,call,progress);
}
/** Source-only half after canonical metadata/reference validation; not a complete read gate. */
export async function assertResearchCallSourceDependencies(db:Queryable,identity:SpaceUserIdentity,call:ResearchCall,progress?:unknown):Promise<void>{
 const metadata=objectValue(progress);
 const channels=[...new Set([...(Array.isArray(call.scope.source_channel_ids)?call.scope.source_channel_ids:[]),...(Array.isArray(metadata.channel_ids)?metadata.channel_ids:[])])];
 const items=Array.isArray(metadata.source_item_ids)?metadata.source_item_ids:[];
 if(items.length){const source=await db.query<{n:number}>(`SELECT count(*)::integer AS n FROM source_items si WHERE si.space_id=$1 AND si.id=ANY($2::varchar[]) AND ${sourceItemFullContentReadClause("si","$3")}`,[identity.spaceId,items,identity.userId]);if(source.rows[0]?.n!==new Set(items).size)throw new ResearchCallContentUnavailable();}
 if(channels.length){
  const connections=await db.query<{id:string;source_connection_id:string}>(`SELECT id,source_connection_id FROM source_channels WHERE space_id=$1 AND id=ANY($2::varchar[])`,[identity.spaceId,channels]);
  if(connections.rows.length!==new Set(channels).size)throw new ResearchCallContentUnavailable();
  for(const id of new Set(connections.rows.map(r=>r.source_connection_id)))if(await contentDecisionFromDb(db,identity,"source_connection",id,{includeOversight:false})!=="full")throw new ResearchCallContentUnavailable();
 }
}

export async function researchPositionHash(db:Queryable,spaceId:string,threadId:string):Promise<string>{
 const result=await db.query<{hash:string}>(`SELECT md5(COALESCE(to_jsonb(q),to_jsonb(h),'{}'::jsonb)::text) AS hash FROM inquiry_threads t LEFT JOIN inquiry_question_states q ON q.thread_id=t.object_id AND q.space_id=t.space_id LEFT JOIN inquiry_hypothesis_states h ON h.thread_id=t.object_id AND h.space_id=t.space_id WHERE t.object_id=$1 AND t.space_id=$2`,[threadId,spaceId]);
 if(!result.rows[0])throw new HttpError(404,"Inquiry Thread not found");return result.rows[0].hash;
}

export async function assertResearchOperationChange(db:Queryable,identity:SpaceUserIdentity,projectId:string,operationId:string):Promise<void>{
 const row=await db.query<{research_call_json:unknown;progress_json:unknown}>(`SELECT research_call_json,progress_json FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3 AND kind='research'`,[operationId,identity.spaceId,projectId]);
 if(!row.rows[0])throw new HttpError(404,"Research operation not found");
 const call=await assertResearchCallReadable(db,identity,projectId,row.rows[0].research_call_json,row.rows[0].progress_json);
 if(call)await assertThreadReadable(db,identity,projectId,call.thread_id,'change');
}
