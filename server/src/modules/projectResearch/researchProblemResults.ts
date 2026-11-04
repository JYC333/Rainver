import { PgUsageRepository } from "../usage/repository.js";
import { resolveResearchReportReferences } from "./reportReferenceResolver.js";
import { ResearchResultSchema, ResearchResultAdoptionSchema, type ProblemReference } from "@rainver/protocol";
import { HttpError, objectValue, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectReadable } from "../projects/access.js";
import { researchPositionHash, assertResearchCallReadable } from "./researchCallAccess.js";
import { assertProblemReferences } from "../inquiry/problemReferences.js";
import { lockProblem } from "../inquiry/problemFacts.js";
import { InquiryProblemEngineService } from "../inquiry/problemEngineService.js";
import { runInheritedReadSql } from "../access/contentAccessSql.js";
import { sourceItemFullContentReadClause } from "../sources/sourceItemAccess.js";
import type { ThreadEventProvenance } from "../inquiry/threadWorkEvents.js";
/** Problem work accepts at most this many input references. Evidence is ordered
 * report archives first; the fact also pins the Operation/attempt/execution, so
 * the complete result stays reachable from the adopted assessment. */
const ADOPTION_INPUT_REF_LIMIT=20;
/** Result is execution evidence, never an accepted answer or a next-work command. */
export class ResearchProblemResultService {
 constructor(private readonly db:Queryable){}
 async read(identity:SpaceUserIdentity,projectId:string,operationId:string){
  await assertProjectReadable(this.db,identity.spaceId,projectId,identity.userId);
  const rows=await this.db.query<Record<string,unknown>>(`SELECT * FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3 AND kind='research'`,[operationId,identity.spaceId,projectId]);
  const op=rows.rows[0];if(!op)throw new HttpError(404,"Research result not found");
  const call=await assertResearchCallReadable(this.db,identity,projectId,op.research_call_json,op.progress_json);
  if(!call)throw new HttpError(409,"This Research is not a problem call; it has no problem result to assess");
  // A result pointer is itself content-bearing. Keep producing Run and all
  // source-item consent/retention gates, including for partial results.
  const state=objectValue(op.progress_json);
  const authorized=await this.db.query<{allowed:boolean}>(`SELECT ${runInheritedReadSql("$1::varchar","$2::varchar","$3::varchar")} AS allowed`,[call.requested_by_run_id,identity.spaceId,identity.userId]);
  if(!authorized.rows[0]?.allowed)throw new HttpError(404,"Research result not found");
  if(typeof state.synthesis_run_id==='string'){
   const producer=await this.db.query<{allowed:boolean}>(`SELECT ${runInheritedReadSql("$1::varchar","$2::varchar","$3::varchar")} AS allowed`,[state.synthesis_run_id,identity.spaceId,identity.userId]);
   if(!producer.rows[0]?.allowed)throw new HttpError(404,"Research result not found");
  }
  const sourceIds=Array.isArray(state.source_item_ids)?state.source_item_ids.filter((x):x is string=>typeof x==='string'):[];
  if(sourceIds.length){
   const source=await this.db.query<{n:number}>(`SELECT count(*)::integer AS n FROM source_items si WHERE si.space_id=$1 AND si.id=ANY($2::varchar[]) AND ${sourceItemFullContentReadClause("si","$3")}`,[identity.spaceId,sourceIds,identity.userId]);
   if(source.rows[0]?.n!==new Set(sourceIds).size)throw new HttpError(404,"Research result not found");
  }
  const reports=await this.db.query<{id:string;archive_artifact_id:string;content_json:unknown}>(`SELECT id,archive_artifact_id,content_json FROM project_research_reports WHERE operation_id=$1 AND space_id=$2 AND project_id=$3 ORDER BY created_at,id LIMIT 20`,[operationId,identity.spaceId,projectId]);
  const artifacts=Array.isArray(state.artifact_ids)?state.artifact_ids.filter((x):x is string=>typeof x==='string'):[];
  const refs:ProblemReference[]=[...new Set([...reports.rows.map(r=>r.archive_artifact_id),...artifacts])].filter(Boolean).map(id=>({type:'artifact',id}));
  await assertProblemReferences(this.db,identity,projectId,refs);
  const findings=[];const reportLimits:string[]=[];
  for(const report of reports.rows){
    const checked=await resolveResearchReportReferences(this.db,identity,objectValue(report.content_json));
    if(checked.resolved.some(r=>r.availability==='unavailable'))throw new HttpError(404,"Research result not found");
    const content=objectValue(checked.content),claims=Array.isArray(content.findings)?content.findings:[];
    const summary=typeof content.summary==='string'?content.summary:'';
    findings.push({report_id:report.id,artifact_id:report.archive_artifact_id,summary:summary.slice(0,4000),claims:claims.slice(0,20).map(v=>{const c=objectValue(v);return {claim:String(c.claim??'').slice(0,2000),support:String(c.support??'').slice(0,2000),references:Array.isArray(c.references)?c.references.slice(0,20).map(objectValue):[]};}),truncated:summary.length>4000||claims.length>20||claims.some(v=>String(objectValue(v).claim??'').length>2000||String(objectValue(v).support??'').length>2000)});
    if(Array.isArray(content.limitations))reportLimits.push(...content.limitations.filter((v):v is string=>typeof v==='string').slice(0,20).map(v=>v.slice(0,2000)));
  }
  const current=await this.db.query<{version:number;problem_revision:number;round:number}>(`SELECT version,problem_revision,(SELECT COALESCE(max(round_number),0)+1 FROM inquiry_round_closeouts c WHERE c.thread_id=t.object_id AND c.space_id=t.space_id)::integer AS round FROM inquiry_threads t WHERE object_id=$1 AND space_id=$2`,[call.thread_id,identity.spaceId]);
  const live=current.rows[0];
  const stale=!live||live.version!==call.thread_version||live.round!==call.round_number||(await researchPositionHash(this.db,identity.spaceId,call.thread_id))!==call.position_hash;
  const runs=await this.db.query<{id:string}>(`SELECT r.id FROM runs r WHERE r.space_id=$1 AND r.project_id=$2 AND (r.id=$3::varchar OR r.id IN (SELECT target_id FROM project_operation_links WHERE operation_id=$4 AND space_id=$1 AND target_type='run')) AND ${runInheritedReadSql("r.id","r.space_id","$5")}`,[identity.spaceId,projectId,typeof state.synthesis_run_id==='string'?state.synthesis_run_id:null,operationId,identity.userId]);
  const usage=await new PgUsageRepository(this.db).summarizeRunUsage(identity.spaceId,projectId,runs.rows.map(r=>r.id));
  const cancellation=op.status==='cancelled'?(await this.db.query<{status:string}>(`SELECT status FROM jobs WHERE space_id=$1 AND job_type='research_operation_cancel' AND payload_json->>'operation_id'=$2 ORDER BY created_at DESC LIMIT 1`,[identity.spaceId,operationId])).rows[0]?.status:null;
  const preparationPending=op.status==='cancelled'?(await this.db.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM jobs j JOIN project_operation_links l ON l.target_type='job' AND l.target_id=j.id AND l.space_id=j.space_id WHERE l.operation_id=$1 AND l.space_id=$2 AND j.job_type='research_pipeline_start' AND j.status IN ('pending','claimed','running')) AS pending`,[operationId,identity.spaceId])).rows[0]?.pending:false;
  return ResearchResultSchema.parse({schema_version:'research_result.v1',call,attempt:op.research_attempt,execution_id:op.current_execution_id??null,status:op.status,applicability:stale?'requires_assessment':'current_snapshot',findings,evidence_refs:refs,limitations:["Execution outcome is not an accepted problem judgment; assess linked reports explicitly.",...reportLimits],unresolved_gaps:state.partial?["Research returned partial material; coverage remains incomplete."]:[],usage:{...usage},diagnostics:{error:state.error??null,reconciliation:op.research_reconcile_json,cancellation:state.cancellation??null,process_stop_state:preparationPending?"requested":cancellation===null?null:cancellation===undefined?"unknown":cancellation==="completed"?"confirmed":["pending","claimed","running"].includes(cancellation)?"requested":"needs_attention"},partial:state.partial===true||(['failed','cancelled'].includes(String(op.status))&&refs.length>0)});
 }
 async adopt(identity:SpaceUserIdentity,projectId:string,operationId:string,body:unknown,provenance?:ThreadEventProvenance){
  const parsed=ResearchResultAdoptionSchema.safeParse(body);if(!parsed.success)throw new HttpError(422,parsed.error.message);
  return withQueryableTransaction(this.db,async tx=>{
   const result=await new ResearchProblemResultService(tx).read(identity,projectId,operationId);
   await lockProblem(tx,identity,projectId,result.call.thread_id);
   if(!['completed','failed','cancelled'].includes(result.status))throw new HttpError(409,"Research must have a terminal outcome before result assessment");
   const input=parsed.data;
   // This is an explicit current-round Verify fact. Protected cognition stays
   // exclusively with recordIteration; successful execution cannot write it.
   return new InquiryProblemEngineService(tx).recordWork(identity,projectId,result.call.thread_id,{method_version:'problem_solving.v1',expected_version:input.expected_version,expected_revision:input.expected_revision,idempotency_key:input.idempotency_key,stage:'verify',work_kind:'assess_result',reason:[`Research ${operationId}: ${input.applicability}. ${input.reason}`,`Counterevidence: ${input.counterevidence}`,`Remaining gaps: ${input.remaining_gaps}`].join('\n'),input_refs:result.evidence_refs.slice(0,ADOPTION_INPUT_REF_LIMIT),output_refs:[]},provenance,{operation_id:operationId,attempt:result.attempt,execution_id:result.execution_id});
  });
 }
}
