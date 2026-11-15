import {pinReportReleaseBatch} from "./reportReleaseBatch.js";
import {OperationRefusal} from '../systemActions/operations/errors.js';
import {ContentAccessAuditService} from '../contentAccess/audit.js';
import {CONTEXT_REPORT_OPERATION_SCHEMAS,type RetrievalObjectType} from '@rainver/protocol';
import {HttpError,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {lockActivePerson} from '../access/activePerson.js';
import {isSpaceOwnerOrAdminIn} from '../routeUtils/access.js';
import {canInitiateContextOpsScan,canReviewSpaceOpsPackets} from '../contextOps/reviewPolicy.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {authorizeJobEffect} from '../jobs/effectAuthority.js';
import {runKnowledgeReport} from '../knowledge/reportWork.js';
import {runMemoryReport} from '../memory/reportWork.js';
import {knowledgeRetrievalRegistry} from '../knowledge/retrievalAdapter.js';
import {memoryRetrievalRegistry} from '../memory/retrievalAdapter.js';
import {projectRetrievalRegistry} from '../projects/retrievalAdapter.js';
import {lockRetrievalReleaseClosure,withheldPinnedReleaseRefs,type ReleaseRef} from './releaseClosure.js';
import {schemaSuggestionFindingsClosed} from './reportClosureContract.js';

export const isContextReport=(operation:string)=>Object.hasOwn(CONTEXT_REPORT_OPERATION_SCHEMAS,operation);
/** Admission and result release use the same current person, Space role and
 * Context Ops opt-in. The caller cannot use an old queue receipt as authority. */
export async function authorizeContextReport(db:Queryable,i:SpaceUserIdentity,op:string,raw:unknown){
 await db.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))',[`runtime-egress-settings:${i.spaceId}`]);
 await lockActivePerson(db,i.spaceId,i.userId);
 await db.query("SELECT id FROM settings WHERE scope_type='space' AND scope_id=$1 ORDER BY id FOR SHARE",[i.spaceId]);
 const b=raw as {review_scope?:string;job_id?:string;llm_judge_enabled?:boolean;llm_extraction_enabled?:boolean};
 if(b.llm_judge_enabled||b.llm_extraction_enabled)throw new OperationRefusal(422,'context_ops','The requested provider adapter is unavailable');
 if(op==='knowledge.eval.report'){
  if(!await isSpaceOwnerOrAdminIn(db,i.spaceId,i.userId))throw new HttpError(404,'Report not found');
 }else if(op!=='memory.consolidation.run'&&!await canInitiateContextOpsScan(db,i.spaceId,i.userId))throw new HttpError(404,'Report not found');
 if(b.review_scope==='space_ops'&&!await canReviewSpaceOpsPackets(db,i.spaceId,i.userId))throw new HttpError(404,'Report not found');
 if(op==='memory.maintenance.job.run'){
  const job=(await db.query<{owner_user_id:string;review_scope:string}>('SELECT owner_user_id,review_scope FROM memory_maintenance_jobs WHERE space_id=$1 AND id=$2',[i.spaceId,b.job_id])).rows[0];
  // Running another person's report would evaluate it as its owner. A shared
  // read permission never delegates that person's execution authority.
  if(!job||job.owner_user_id!==i.userId)throw new HttpError(404,'Maintenance job not found');
  if(job.review_scope==='space_ops'&&!await canReviewSpaceOpsPackets(db,i.spaceId,i.userId))throw new HttpError(404,'Maintenance job not found');
 }
}
export async function runContextReport(db:Queryable,i:SpaceUserIdentity,op:string,raw:unknown){
 // Consolidation owns a short transaction per activity. Its established
 // per-item proposal/provenance path is not wrapped in a second outer commit.
 if(op==='memory.consolidation.run'){
  await withQueryableTransaction(db,tx=>authorizeContextReport(tx,i,op,raw));
  return runMemoryReport(db,i,op,raw);
 }
 return withQueryableTransaction(db,async tx=>{
  await authorizeContextReport(tx,i,op,raw);
  await authorizeJobEffect(tx);
  return op.startsWith('knowledge.')?runKnowledgeReport(tx,i,op,raw):runMemoryReport(tx,i,op,raw);
 });
}
type Ref={type:string;id:string};
/** Every typed report reference is rechecked, including nested proposed actions
 * and input artifacts. No report fragment or count survives a refused reference. */
export function contextReportReferences(value:unknown):Ref[]{
 const refs=new Map<string,Ref>();
 const add=(type:string,id:unknown)=>{if(typeof id==='string'&&id)refs.set(type+':'+id,{type,id});};
 const keys:Record<string,string>={claim_id:'space_object',from_claim_id:'space_object',to_claim_id:'space_object',subject_object_id:'space_object',from_object_id:'space_object',to_object_id:'space_object',memory_id:'memory',target_memory_id:'memory',target_memory_ids:'memory',related_memory_ids:'memory',artifact_id:'artifact',last_report_artifact_id:'artifact',last_packet_proposal_id:'proposal',source_artifact_ids:'artifact',evidence_artifact_ids:'artifact',candidate_packet_artifact_id:'artifact',proposal_id:'proposal',proposal_ids:'proposal',proposals_created:'proposal',candidate_packet_proposal_id:'proposal',activity_id:'activity',activity_ids:'activity',activities_processed:'activity',activities_skipped:'activity',activities_failed:'activity',activities_awaiting_share:'activity',match_ids:'memory'};
 const visit=(v:unknown)=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(visit);return;}const r=v as Record<string,unknown>;
  if(typeof r.object_type==='string'&&typeof r.object_id==='string')add(['knowledge_item','note','claim','source','person','organization'].includes(r.object_type)?'space_object':r.object_type==='memory_entry'?'memory':r.object_type,r.object_id);
  for(const [k,x] of Object.entries(r)){if(keys[k]){if(Array.isArray(x))x.forEach(id=>add(keys[k]!,id));else add(keys[k]!,x);}visit(x);}
 };visit(value);return [...refs.values()];
}
/** How many references of one report value are not releasable to this
 * person NOW, in the caller's transaction: pin the shared ordered closure of
 * every referenced Knowledge/Memory object (with its Source lineage) and every
 * other referenced resource, recheck the report authority, require `full` on
 * every reference, then run the same release decision as a live search result
 * — adapter read and the Source policy gate (`sourcePolicyAllowsRead`:
 * consent, archive, owner) over each Knowledge/Memory reference's canonical
 * Source lineage, with no projection dependency (`withheldPinnedReleaseRefs`
 * `canonical`). A published Project public summary ref (a schema suggestion
 * counting it) joins the same closure through the Project registry: the
 * Project audience is pinned with the Source closure, and the release needs
 * the live publication, an active Project and the publication's Source
 * references passing the viewer's Source policy. It has no content resource
 * of its own and records no content read. A lost report authority throws (404). On a full release with
 * `auditReason`, records the reads (B11: only for a viewer other than the
 * owner). `exclude` drops one self-reference (a stored report's own id). */
export async function withheldContextReport(tx:Queryable,i:SpaceUserIdentity,op:string,input:unknown,value:unknown,auditReason:string|null,exclude?:Ref):Promise<number>{
 // Schema suggestion counts must name every counted row (poll result
 // `report.findings`, stored report `findings`); a count without its rows
 // (an older result) cannot be rechecked.
 if(op==='knowledge.object_schema.suggestions.scan'){const v=value&&typeof value==='object'?value as {report?:{findings?:unknown};findings?:unknown}:{};if(!schemaSuggestionFindingsClosed(v.report?v.report.findings:v.findings))return 1;}
 await pinReportReleaseBatch(tx,i,[input,value]);
 const all=contextReportReferences([input,value]).filter(r=>!exclude||r.type!==exclude.type||r.id!==exclude.id);
 const refs=all.filter(r=>r.type!=='project_public_summary');
 const summaries:ReleaseRef[]=all.filter(r=>r.type==='project_public_summary').map(r=>({object_type:'project_public_summary',object_id:r.id}));
 const knowledge:ReleaseRef[]=[],memory:ReleaseRef[]=[];
 for(const r of refs){if(r.type==='memory')memory.push({object_type:'memory_entry',object_id:r.id});
  if(r.type==='space_object'){const row=(await tx.query<{object_type:RetrievalObjectType}>('SELECT object_type FROM space_objects WHERE space_id=$1 AND id=$2',[i.spaceId,r.id])).rows[0];if(row&&knowledgeRetrievalRegistry.objectTypes().includes(row.object_type))knowledge.push({object_type:row.object_type,object_id:r.id});}}
 const groups=[{registry:knowledgeRetrievalRegistry,refs:knowledge},{registry:memoryRetrievalRegistry,refs:memory},{registry:projectRetrievalRegistry,refs:summaries}].filter(g=>g.refs.length);
 await lockRetrievalReleaseClosure(tx,i.spaceId,i.userId,groups,refs.map(r=>({object_type:r.type as never,object_id:r.id})));
 await authorizeContextReport(tx,i,op,input);
 for(const r of refs){if(!contentResourceDefinition(r.type)||await contentDecisionFromDb(tx,i,r.type,r.id)!=='full')return 1;}
 const withheld=await withheldPinnedReleaseRefs(tx,i,groups,null,{canonical:true});
 if(withheld||auditReason===null)return withheld;
 for(const type of new Set(refs.map(r=>r.type)))await new ContentAccessAuditService(tx).recordReads({spaceId:i.spaceId,viewerUserId:i.userId,resourceType:type,resourceIds:refs.filter(r=>r.type===type).map(r=>r.id),accessType:'read',reason:auditReason});
 return 0;
}
/** A report result is released whole or not at all, in one transaction
 * (`withheldContextReport`). Any refusal withholds every finding, title and
 * count. Serves every Knowledge and Memory report operation (maintenance,
 * eval, contradictions, relations, schema suggestions, Memory
 * maintenance/Job, consolidation); a persisted report Artifact passes the
 * same closure on every read (`retrieval/artifactRelease.ts`). */
export async function releaseContextReport(db:Queryable,i:SpaceUserIdentity,op:string,input:unknown,value:unknown){
 return withQueryableTransaction(db,async tx=>{
  const withheld=await withheldContextReport(tx,i,op,input,value,'Context report result read');
  return withheld?{result:null,withheld}:{result:value,withheld:0};
 });
}
