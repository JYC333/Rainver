import {reportReleasePlans} from "./reportReleasePlan.js";
import {pinReportReleaseBatch} from "./reportReleaseBatch.js";
import {AsyncLocalStorage} from 'node:async_hooks';
import type {RetrievalObjectType} from '@rainver/protocol';
import {HttpError,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {isSpaceOwnerOrAdminIn} from '../routeUtils/access.js';
import {lockCurrentJobClaim} from '../jobs/effectAuthority.js';
import type {JobEnvelopeForHandler} from '../jobs/handlerRegistry.js';
import type {RetrievalRegistry} from './registry.js';
import {withheldReleaseRefs,type ReleaseGroup,type ReleaseRef} from './releaseClosure.js';
import {REPORT_DEPENDENCY_CLOSURE_VERSION,schemaSuggestionFindingsClosed} from './reportClosureContract.js';

type Ref=ReleaseRef;
/** Retrieval outputs whose stored body is derived from other Space objects:
 * a Brief or Explain report, and the Ask Space session aggregate built over
 * per-domain Briefs. */
export const RETRIEVAL_DERIVED_ARTIFACT_TYPES=['retrieval_brief','retrieval_explain_report','ask_space_session','cross_space_source_summary','cross_space_fused_conclusion'] as const;
/** Persisted Knowledge/Memory report Artifacts and the report operation whose
 * current authority and reference closure (`withheldContextReport`) their
 * stored body must pass on every read — the same gate as that operation's
 * poll result. The review-cycle and observation reports are Context Ops
 * scans; an eval report written by the product diagnostics run is a
 * diagnostics report. */
export const CONTEXT_REPORT_ARTIFACT_OPERATIONS:Readonly<Record<string,string>>={
 retrieval_maintenance_report:'knowledge.maintenance.scan',
 memory_maintenance_report:'memory.maintenance.scan',
 retrieval_eval_report:'knowledge.eval.report',
 retrieval_calibration_decision:'knowledge.eval.calibration.record',
 claim_contradiction_report:'knowledge.claim.contradictions.scan',
 claim_candidate_packet:'knowledge.claim.candidate_packet.create',
 relation_discovery_report:'knowledge.relation.discovery.scan',
 object_schema_suggestion_report:'knowledge.object_schema.suggestions.scan',
 context_review_cycle_report:'knowledge.maintenance.scan',
 context_observation_report:'knowledge.maintenance.scan',
};
const MAINTENANCE_REPORT_TYPES=new Set(['retrieval_maintenance_report','memory_maintenance_report']);
/** Whether a stored Artifact's body and metadata are gated by a current
 * release closure (retrieval-derived or report). */
export const releaseGatedArtifactType=(type:string)=>(RETRIEVAL_DERIVED_ARTIFACT_TYPES as readonly string[]).includes(type)||Object.hasOwn(CONTEXT_REPORT_ARTIFACT_OPERATIONS,type);
/** A withheld report's stored title carries derived counts ("N findings");
 * it is replaced by its type label. Brief/Explain/session titles are the
 * owner's own query and stay. */
export const withheldArtifactTitle=(type:string,title:string)=>Object.hasOwn(CONTEXT_REPORT_ARTIFACT_OPERATIONS,type)?type.split('_').map((w,n)=>n?w:w[0]!.toUpperCase()+w.slice(1)).join(' '):title;
/** A maintenance report's findings each name the objects they derive from;
 * a finding without well-formed object refs (an older or damaged record)
 * cannot be checked and fails closed. */
function maintenanceFindingsWellFormed(metadata:Record<string,unknown>):boolean{
 if(!Array.isArray(metadata.findings))return false;
 return metadata.findings.every(f=>{const r=record(f);return Boolean(r&&Array.isArray(r.objects)&&r.objects.every(o=>{const v=record(o);return Boolean(v&&typeof v.object_type==='string'&&v.object_type&&typeof v.object_id==='string'&&v.object_id);}));});
}
const stampedClosure=(metadata:Record<string,unknown>)=>record(metadata.dependency_closure)?.version===REPORT_DEPENDENCY_CLOSURE_VERSION;
const isDiagnosticsReport=(type:string,metadata:Record<string,unknown>)=>type==='retrieval_eval_report'&&metadata.source==='product_diagnostic';
/** Whether a stored aggregate report's body honours its dependency-closure
 * contract (see `REPORT_DEPENDENCY_CLOSURE_VERSION`). */
function aggregateReportClosed(type:string,metadata:Record<string,unknown>):boolean{
 const sources=()=>stampedClosure(metadata)&&Array.isArray(metadata.source_artifact_ids)&&metadata.source_artifact_ids.every(id=>typeof id==='string'&&id);
 if(isDiagnosticsReport(type,metadata)||type==='context_observation_report')return sources();
 if(type==='object_schema_suggestion_report')return stampedClosure(metadata)&&schemaSuggestionFindingsClosed(metadata.findings);
 return true;
}
async function contextReportArtifactWithheld(db:Queryable,identity:SpaceUserIdentity,artifact:{id?:string;artifact_type:string;metadata_json:unknown},auditReason:string|null):Promise<boolean>{
 const metadata=record(artifact.metadata_json);
 if(!metadata)return true;
 if(MAINTENANCE_REPORT_TYPES.has(artifact.artifact_type)&&!maintenanceFindingsWellFormed(metadata))return true;
 if(!aggregateReportClosed(artifact.artifact_type,metadata))return true;
 const op=isDiagnosticsReport(artifact.artifact_type,metadata)?'knowledge.eval.diagnostics.report':CONTEXT_REPORT_ARTIFACT_OPERATIONS[artifact.artifact_type]!;
 const {withheldContextReport}=await import('./contextReports.js');
 try{
  return await withQueryableTransaction(db,async tx=>await withheldContextReport(tx,identity,op,{review_scope:metadata.review_scope==='space_ops'?'space_ops':undefined},metadata,auditReason,artifact.id?{type:'artifact',id:artifact.id}:undefined)>0);
 }catch(error){if(error instanceof HttpError&&[403,404,409].includes(error.statusCode))return true;throw error;}
}
const reportChain=new AsyncLocalStorage<readonly string[]>();
/** Deepest legitimate nesting is calibration -> eval -> diagnostics ->
 * maintenance/Brief, or a claim packet over such reports. */
const MAX_REPORT_CHAIN_DEPTH=8;
export class RetrievalArtifactWithheld extends Error{constructor(){super('A contributing source is no longer releasable to this person');this.name='RetrievalArtifactWithheld';}}

// Registries and the search service are loaded lazily: the access gate and the
// Artifact persisters sit below the domain adapters in the import graph.
async function registries(){
 const [k,m,s,p,i]=await Promise.all([import('../knowledge/retrievalAdapter.js'),import('../memory/retrievalAdapter.js'),import('../sources/retrievalAdapter.js'),import('../projects/retrievalAdapter.js'),import('../inquiry/retrievalAdapter.js')]);
 return {knowledge:k.knowledgeRetrievalRegistry,memory:m.memoryRetrievalRegistry,source:s.sourceRetrievalRegistry,project:p.projectRetrievalRegistry,inquiry:i.inquiryRetrievalRegistry};
}

/** Refs owned by one registry, checked by the shared release closure
 * (`releaseClosure.ts`) in the caller's transaction. Returns the number of
 * refs that are not releasable now. */
export async function withheldRetrievalRefs(tx:Queryable,identity:SpaceUserIdentity,registry:RetrievalRegistry,refs:readonly Ref[],auditReason:string|null,options:{rawMemory?:boolean}={}):Promise<number>{
 return withheldReleaseRefs(tx,identity,[{registry,refs}],auditReason,options);
}

/** Every ref a Brief/Explain body or metadata derives from: items, citations,
 * stale/thin and LLM gap refs, and an Explain target. */
export function retrievalContributingRefs(metadata:Record<string,unknown>):{refs:Ref[];malformed:boolean}{
 const refs:Ref[]=[];let malformed=false;
 const take=(value:unknown)=>{
  if(!value||typeof value!=='object')return;
  const v=value as Record<string,unknown>;
  if(typeof v.object_type==='string'&&typeof v.object_id==='string')refs.push({object_type:v.object_type as RetrievalObjectType,object_id:v.object_id});
  else malformed=true;
 };
 const list=(value:unknown)=>{if(value===undefined||value===null)return;if(!Array.isArray(value)){malformed=true;return;}value.forEach(take);};
 list(metadata.item_refs);list(metadata.citations);
 const gaps=metadata.gap_analysis;
 // stale/thin are ref lists; LLM gap findings (strings or free-form records)
 // contribute only the refs they carry, never by being unparseable.
 if(gaps&&typeof gaps==='object'){
  const g=gaps as Record<string,unknown>;list(g.stale);list(g.thin);
  for(const [key,value] of Object.entries(g))if(key!=='stale'&&key!=='thin'&&Array.isArray(value))for(const v of value)if(v&&typeof v==='object'&&typeof (v as Record<string,unknown>).object_type==='string'&&typeof (v as Record<string,unknown>).object_id==='string')take(v);
 }
 if(metadata.target!==undefined)take(metadata.target);
 return {refs,malformed};
}

type Registries=Awaited<ReturnType<typeof registries>>;
const record=(v:unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;

/** The single-registry closure of a Brief or Explain report. */
function briefGroups(r:Registries,artifactType:string,metadata:Record<string,unknown>):ReleaseGroup[]|null{
 const {refs,malformed}=retrievalContributingRefs(metadata);
 if(malformed)return null;
 const all=Object.values(r);
 const owners=new Set(refs.map(ref=>all.find(registry=>registry.objectTypes().includes(ref.object_type))));
 if(owners.has(undefined)||owners.size>1)return null;
 if(artifactType==='retrieval_explain_report'&&owners.size&&!owners.has(r.knowledge))return null;
 const registry=[...owners][0];
 return registry?[{registry,refs}]:[];
}

/** An Ask Space session derives its combined answer, gap summary and
 * provenance from every answering domain, including one whose own Brief
 * failed to save. Its closure is the recorded per-domain `contributions`;
 * every nested Brief and every provenance entry must lie inside it. Anything
 * unresolvable (no contributions, unknown domain, a ref outside its domain, a
 * missing or foreign nested Brief) fails closed. */
async function sessionGroups(tx:Queryable,identity:SpaceUserIdentity,r:Registries,metadata:Record<string,unknown>):Promise<ReleaseGroup[]|null>{
 const domains:Record<string,RetrievalRegistry>={knowledge:r.knowledge,memory:r.memory,source:r.source,project:r.project,inquiry:r.inquiry};
 if(!Array.isArray(metadata.contributions))return null;
 const byDomain=new Map<string,Map<string,Ref>>();
 for(const entry of metadata.contributions){
  const e=record(entry),registry=e&&typeof e.domain==='string'?domains[e.domain]:undefined;
  if(!e||!registry||!Array.isArray(e.refs))return null;
  const refs=byDomain.get(e.domain as string)??new Map<string,Ref>();
  for(const value of e.refs){const v=record(value);if(!v||typeof v.object_type!=='string'||typeof v.object_id!=='string'||!registry.objectTypes().includes(v.object_type as RetrievalObjectType))return null;refs.set(v.object_type+':'+v.object_id,{object_type:v.object_type as RetrievalObjectType,object_id:v.object_id});}
  byDomain.set(e.domain as string,refs);
 }
 const inside=(domain:unknown,ref:{object_type:unknown;object_id:unknown})=>typeof domain==='string'&&Boolean(byDomain.get(domain)?.has(String(ref.object_type)+':'+String(ref.object_id)));
 for(const value of Array.isArray(metadata.provenance)?metadata.provenance:metadata.provenance===undefined?[]:[null]){const v=record(value);if(!v||!inside(v.domain,v as {object_type:unknown;object_id:unknown}))return null;}
 const nested=metadata.brief_artifact_refs===undefined?[]:metadata.brief_artifact_refs;
 if(!Array.isArray(nested))return null;
 for(const value of nested){
  const v=record(value);if(!v||typeof v.artifact_id!=='string')return null;
  const brief=(await tx.query<{metadata_json:unknown}>("SELECT metadata_json FROM artifacts WHERE space_id=$1 AND id=$2 AND artifact_type='retrieval_brief' AND owner_user_id=$3",[identity.spaceId,v.artifact_id,identity.userId])).rows[0];
  const m=record(brief?.metadata_json);if(!m)return null;
  const {refs,malformed}=retrievalContributingRefs(m);
  if(malformed||refs.some(ref=>!inside(v.domain,ref)))return null;
 }
 const groups=new Map<RetrievalRegistry,Ref[]>();
 for(const [domain,refs] of byDomain){const registry=domains[domain]!;groups.set(registry,[...(groups.get(registry)??[]),...refs.values()]);}
 return [...groups].map(([registry,refs])=>({registry,refs}));
}

/** Whether a retrieval-derived Artifact (Brief, Explain report or Ask Space
 * session) must be withheld whole from this person NOW. Every contributing
 * ref passes the same canonical release closure as the live request result —
 * root decision `full`, adapter read, Source policy — under one ordered lock
 * set; any withheld, unknown, mixed-domain (Brief/Explain) or unparseable
 * dependency withholds the whole derived body and metadata. An Explain report
 * also needs the current Space maintenance role. A persisted report
 * (`CONTEXT_REPORT_ARTIFACT_OPERATIONS`) passes its operation's poll closure
 * instead (`withheldContextReport`): current report authority, every
 * referenced object `full` with its Source policy; any withheld reference,
 * lost authority or malformed maintenance finding withholds it whole. Other
 * Artifact types are unaffected. A changed lineage while waiting fails
 * closed. */
export async function retrievalArtifactWithheld(db:Queryable,identity:SpaceUserIdentity,artifact:{id?:string;artifact_type:string;metadata_json:unknown},auditReason:string|null):Promise<boolean>{
 if(reportReleasePlans.has(db))await pinReportReleaseBatch(db,identity,[artifact]);
 if(artifact.artifact_type==='cross_space_source_summary'||artifact.artifact_type==='cross_space_fused_conclusion'){
  if(!artifact.id)return true;
  const {CrossSpaceRetrievalService}=await import('../crossSpaceRetrieval/service.js');
  try{
   return await withQueryableTransaction(db,async tx=>{
    await new CrossSpaceRetrievalService(tx,auditReason!==null).authorizeStoredResult(identity.userId,{artifact_id:artifact.id});
    return false;
   });
  }catch(error){if(error instanceof HttpError&&[403,404,409].includes(error.statusCode))return true;throw error;}
 }

 if(Object.hasOwn(CONTEXT_REPORT_ARTIFACT_OPERATIONS,artifact.artifact_type)){
  // A report names the reports it derives from, and each is rechecked
  // through `contentDecisionFromDb` -> here. The chain of report Artifacts
  // being checked on this path bounds that recursion: a cycle or an
  // over-deep chain fails closed instead of recursing.
  const chain=reportChain.getStore()??[];
  if(artifact.id&&chain.includes(artifact.id)||chain.length>=MAX_REPORT_CHAIN_DEPTH)return true;
  return reportChain.run(artifact.id?[...chain,artifact.id]:chain,()=>contextReportArtifactWithheld(db,identity,artifact,auditReason));
 }
 if(!(RETRIEVAL_DERIVED_ARTIFACT_TYPES as readonly string[]).includes(artifact.artifact_type))return false;
 const metadata=record(artifact.metadata_json);
 if(!metadata)return true;
 const r=await registries();
 const explain=artifact.artifact_type==='retrieval_explain_report';
 try{
  return await withQueryableTransaction(db,async tx=>{
   const groups=artifact.artifact_type==='ask_space_session'?await sessionGroups(tx,identity,r,metadata):briefGroups(r,artifact.artifact_type,metadata);
   if(!groups)return true;
   if(groups.length&&await withheldReleaseRefs(tx,identity,groups,auditReason)>0)return true;
   // Role after the release closure: membership follows audience locks.
   return explain&&!await isSpaceOwnerOrAdminIn(tx,identity.spaceId,identity.userId);
  });
 }catch(error){if(error instanceof HttpError&&(error.statusCode===409||error.statusCode===403))return true;throw error;}
}

/** After provider I/O, persist a retrieval-derived Artifact in one short
 * transaction: lock the current Job claim (when running as a Job), re-run the
 * complete current release closure for its contributing refs (and Explain's
 * maintenance role), then write. Lost claim or withdrawn authority writes
 * nothing; unknown outcomes are not retried here. */
export async function settleRetrievalArtifact<T>(db:Queryable,identity:SpaceUserIdentity,artifact:{artifact_type:string;metadata_json:unknown},write:(tx:Queryable)=>Promise<T>,job?:JobEnvelopeForHandler):Promise<T>{
 return withQueryableTransaction(db,async tx=>{
  await lockCurrentJobClaim(tx,job);
  if(await retrievalArtifactWithheld(tx,identity,artifact,null))throw new RetrievalArtifactWithheld();
  return write(tx);
 });
}
