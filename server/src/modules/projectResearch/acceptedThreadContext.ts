import { HttpError, objectValue, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectWriter } from "../projects/access.js";
import { assertThreadReadable } from "../inquiry/threadAccess.js";
import { ResearchContextRepository } from "./question/researchContextRepository.js";
/** Accepted problem is enough to plan a bounded search. FINER remains an
 * optional Frame assessment, whose existing sessions/versions are preserved. */
export async function acceptedThreadContext(db:Queryable,identity:SpaceUserIdentity,projectId:string,threadId:string):Promise<string>{
 await assertProjectWriter(db,identity.spaceId,projectId,identity.userId);
 await assertThreadReadable(db,identity,projectId,threadId,"read_content");
 const t=await db.query<{statement:string;version:number}>(`SELECT statement,version FROM inquiry_threads WHERE object_id=$1 AND space_id=$2 AND project_id=$3 AND lifecycle_status='active'`,[threadId,identity.spaceId,projectId]);
 if(!t.rows[0])throw new HttpError(404,"Inquiry Thread not found");
 const confirmed=await db.query<{id:string;context_json:unknown}>(`SELECT id,context_json FROM project_research_context_versions WHERE space_id=$1 AND project_id=$2 AND provenance_json->>'source'='question_assessment_confirmation' AND provenance_json->>'thread_id'=$3 ORDER BY version DESC LIMIT 1`,[identity.spaceId,projectId,threadId]);
 const inherited=objectValue(confirmed.rows[0]?.context_json);
 const strings=(v:unknown)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'):[];
 const existing=await db.query<{id:string}>(`SELECT id FROM project_research_context_versions WHERE space_id=$1 AND project_id=$2 AND provenance_json->>'source'='accepted_thread_frame' AND provenance_json->>'thread_id'=$3 AND provenance_json->>'thread_version'=$4 AND provenance_json->>'inherited_context_id' IS NOT DISTINCT FROM $5::text ORDER BY version DESC LIMIT 1`,[identity.spaceId,projectId,threadId,String(t.rows[0].version),confirmed.rows[0]?.id??null]);
 if(existing.rows[0])return existing.rows[0].id;
 const result=await new ResearchContextRepository(db).create(identity,projectId,{schema_version:'research_context.v1',objective:t.rows[0].statement,sub_questions:inherited.objective===t.rows[0].statement?strings(inherited.sub_questions):[],in_scope:strings(inherited.in_scope),out_of_scope:strings(inherited.out_of_scope),must_have:strings(inherited.must_have),nice_to_have:strings(inherited.nice_to_have),time_window:inherited.time_window as {from:string|null;to:string|null}|null??null,source_scope:{providers:['arxiv','openalex'],include_web:false}},{assessment:{method:'accepted_thread_frame',finer_evaluated:false},provenance:{source:'accepted_thread_frame',thread_id:threadId,thread_version:t.rows[0].version,inherited_context_id:confirmed.rows[0]?.id??null}});
 return result.id;
}
/** Internal execution basis, never an HTTP/model flag or synthetic FINER score. */
export async function assertAcceptedThreadContext(db:Queryable,identity:SpaceUserIdentity,projectId:string,threadId:string,contextId:string){
 await assertProjectWriter(db,identity.spaceId,projectId,identity.userId);
 await assertThreadReadable(db,identity,projectId,threadId,"read_content");
 const match=await db.query(`SELECT 1 FROM project_research_context_versions c JOIN inquiry_threads t ON t.object_id=$3 AND t.space_id=c.space_id AND t.project_id=c.project_id WHERE c.id=$1 AND c.space_id=$2 AND c.project_id=$4 AND t.lifecycle_status='active' AND c.provenance_json->>'source'='accepted_thread_frame' AND c.provenance_json->>'thread_id'=t.object_id AND c.provenance_json->>'thread_version'=t.version::text`,[contextId,identity.spaceId,threadId,projectId]);
 if(!match.rows[0])throw new HttpError(409,"Accepted Thread context changed; plan from its current version");
}
