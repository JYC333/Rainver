import {z} from 'zod';
import {createHash} from 'node:crypto';
import {SourceMaterialInvestigationSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {getDbPool} from '../../../db/pool.js';
import {HttpError,withDbTransaction,type Queryable} from '../../routeUtils/common.js';
import type {RunRecord} from '../../runs/repository.js';
import {PgReaderRepository} from '../../reader/repository.js';
import {RetrievalSearchService} from '../../retrieval/index.js';
import {sourceRetrievalRegistry} from '../retrievalAdapter.js';
import {sourceItemFullContentReadClause} from '../sourceItemAccess.js';
import {assertReadingRunEgress} from '../readingMethods/context.js';
import {agentReadingPolicy} from './policy.js';
import {assertItemProcessingDispatch,materialItemContext} from './items.js';
import {materialRunExpired} from './executionBudget.js';

export interface ReadingHistoryRef {item_id:string;artifact_id:string;content_hash:string;snapshot_id?:string}
const historyRefs=z.array(z.object({item_id:z.string().min(1).max(64),artifact_id:z.string().min(1).max(64),content_hash:z.string().min(1).max(128),snapshot_id:z.string().min(1).max(64).optional()}).strict()).max(16);
interface InvestigationState {calls:number;searches:number;refs:ReadingHistoryRef[];read_ids:string[];checked_hash?:string;questions?:unknown;historical_comparison?:string;remaining_gaps?:string[];stop_reason?:string}
export const reportHash=(text:string)=>createHash('sha256').update(text.trim()).digest('hex');
export function investigationOf(run:RunRecord){return (run.contract_snapshot_json as {workflow_input_json?:{material_processing?:{investigation?:boolean}}})?.workflow_input_json?.material_processing?.investigation===true;}
const empty=():InvestigationState=>({calls:0,searches:0,refs:[],read_ids:[]});

/** Never copy private/selected-user material into a more widely readable report.
 * Same-project shared items and Space-shared items can feed a Project report;
 * a private input can feed only a private report owned by the same person. */
async function historyDocument(db:Queryable,config:ServerConfig,run:RunRecord,targetId:string,itemId:string,artifactId?:string){
 const scope=(await db.query<{connection_id:string|null}>(`SELECT h.connection_id FROM source_items h JOIN source_items target ON target.space_id=h.space_id AND target.id=$2
 WHERE h.space_id=$1 AND h.id=$3 AND h.deleted_at IS NULL AND target.deleted_at IS NULL
 AND ${sourceItemFullContentReadClause('h','$4')}
 AND (h.project_id IS NULL OR h.project_id IS NOT DISTINCT FROM target.project_id)
 AND (h.visibility='space_shared' OR (h.visibility='private' AND target.visibility='private' AND h.owner_user_id=target.owner_user_id))`,[run.space_id,targetId,itemId,run.instructed_by_user_id])).rows[0];
 if(!scope)throw new HttpError(404,'History material unavailable for this report audience');
 if(scope.connection_id){
  const source=(await db.query(`SELECT * FROM source_connections WHERE space_id=$1 AND id=$2`,[run.space_id,scope.connection_id])).rows[0];
  if(!source||!agentReadingPolicy(source as Parameters<typeof agentReadingPolicy>[0]).content)throw new HttpError(403,'History Source does not allow retained analysis');
  await assertReadingRunEgress(db,run,scope.connection_id);
 }
 // Check the whole current output audience, without Space oversight. Artifact
 // checks in Reader remain independent from item sharing.
 const readers=(await db.query<{user_id:string}>(`SELECT m.user_id FROM space_memberships m JOIN source_items target ON target.space_id=m.space_id AND target.id=$2 WHERE m.space_id=$1 AND m.status='active' AND ${sourceItemFullContentReadClause('target','m.user_id')}`,[run.space_id,targetId])).rows;
 if(!readers.length)throw new HttpError(403,'Reading audience unavailable');
 const reader=new PgReaderRepository(db,config);let doc:Awaited<ReturnType<typeof reader.getDocument>>=null;
 for(const member of readers){
  if(!(await db.query(`SELECT h.id FROM source_items h WHERE h.space_id=$1 AND h.id=$2 AND h.deleted_at IS NULL AND ${sourceItemFullContentReadClause('h','$3')}`,[run.space_id,itemId,member.user_id])).rows.length)throw new HttpError(403,'History is not shared with the report audience');
  let visible=await reader.getDocument({spaceId:run.space_id,userId:member.user_id},'source_item',itemId,{recordOpen:false});
  if(artifactId&&visible?.artifact_id!==artifactId){const snapshot=(await db.query<{id:string}>(`SELECT id FROM source_snapshots WHERE space_id=$1 AND source_item_id=$2 AND artifact_id=$3 AND snapshot_type='extracted' ORDER BY captured_at DESC,id DESC LIMIT 1`,[run.space_id,itemId,artifactId])).rows[0];visible=snapshot?await reader.getDocument({spaceId:run.space_id,userId:member.user_id},'source_snapshot',snapshot.id):null;}
  if(!visible?.artifact_id)throw new HttpError(404,'History body unavailable');
  if(member.user_id===run.instructed_by_user_id)doc=visible;
 }
 if(!doc?.artifact_id)throw new HttpError(404,'History body unavailable');
 const artifact=(await db.query<{metadata_json:{reading_history_refs?:ReadingHistoryRef[]}}>(`SELECT a.metadata_json FROM artifacts a JOIN source_items target ON target.space_id=a.space_id AND target.id=$2 WHERE a.space_id=$1 AND a.id=$3 AND (a.project_id IS NULL OR a.project_id IS NOT DISTINCT FROM target.project_id) AND (a.visibility='space_shared' AND a.run_id IS NULL OR a.visibility='private' AND target.visibility='private' AND a.owner_user_id=target.owner_user_id)`,[run.space_id,targetId,doc.artifact_id])).rows[0];
 if(!artifact)throw new HttpError(403,'Historical artifact cannot be republished to this audience');
 const parsed=historyRefs.safeParse(artifact.metadata_json?.reading_history_refs??[]);if(!parsed.success)throw new HttpError(403,'Historical dependency scope is invalid');
 return {...doc,dependencies:parsed.data};
}

/** One action, bounded to the original Run and item. No model loop, fallback or unscoped retrieval. */
export async function investigateMaterial(config:ServerConfig,run:RunRecord,raw:unknown){
 const input=SourceMaterialInvestigationSchema.parse(raw),db=getDbPool(config.databaseUrl!);
 return withDbTransaction(db,async tx=>{
  const live=(await tx.query<RunRecord>(`SELECT * FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE`,[run.id,run.space_id])).rows[0];
  if(!live||live.status!=='running'||!live.started_at||materialRunExpired(live)||!investigationOf(live))throw new HttpError(403,'Investigation is not active');
  const grants=(live.permission_snapshot_json as {tool_grants?:{action_id:string}[]})?.tool_grants??[];
  if(!grants.some(g=>g.action_id==='source.material.investigate'))throw new HttpError(403,'Investigation action not granted');
  const admitted=await assertItemProcessingDispatch(tx,config,live);if(!admitted)throw new HttpError(403,'Investigation scope unavailable');
  const context=materialItemContext(live)!;
  const operation=(await tx.query<{metadata_json:{investigation?:InvestigationState}}>(`SELECT metadata_json FROM extraction_jobs WHERE id=$1 AND space_id=$2 FOR UPDATE`,[context.id,run.space_id])).rows[0];
  const state=operation.metadata_json.investigation??empty();
  if(state.calls>=12)throw new HttpError(429,'Investigation action budget exhausted; keep known limitations');
  state.calls++; delete state.checked_hash;
  let result:unknown;
  if(input.operation==='search'){
   if(state.searches>=3)throw new HttpError(429,'At most three history searches');
   const found=await new RetrievalSearchService(tx,sourceRetrievalRegistry).search({spaceId:run.space_id,viewerUserId:run.instructed_by_user_id!,agentId:run.agent_id,query:input.query,objectTypes:['source_item'],mode:'lexical',maxResults:8});
   const items=[];
   for(const hit of found.items){
    if(hit.object_id===context.item_id)continue;
    try{
     const doc=await historyDocument(tx,config,live,context.item_id,hit.object_id);
     const ref={item_id:hit.object_id,artifact_id:doc.artifact_id!,content_hash:doc.content_hash};
     if(!state.refs.some(r=>r.item_id===ref.item_id)&&state.refs.length>=8)continue;
     if(!state.refs.some(r=>r.artifact_id===ref.artifact_id))state.refs.push(ref);
     for(const dependency of doc.dependencies)if(!state.refs.some(r=>r.artifact_id===dependency.artifact_id))state.refs.push(dependency);
     if(state.refs.length>16)throw new HttpError(403,'History dependency scope is too large');
     items.push({item_id:hit.object_id,title:doc.title,source_uri:doc.source_uri,excerpt:doc.plain_text.slice(0,500),provenance:doc.reading_info,read_status:'unknown',acceptance_status:'unknown'});
    }catch(error){if(error instanceof HttpError&&[403,404,409].includes(error.statusCode))continue;throw error;}
   }
   state.searches++; result={items,coverage:'Bounded indexed Source search; not a whole-library scan. Empty means no eligible match in this search, not an empty library.'};
  }else if(input.operation==='read'){
   if(!state.refs.some(r=>r.item_id===input.item_id))throw new HttpError(403,'Read a candidate from this Run history search first');
   if(!state.read_ids.includes(input.item_id)&&state.read_ids.length>=5)throw new HttpError(429,'At most five retained history documents');
   const doc=await historyDocument(tx,config,live,context.item_id,input.item_id);
   if(!state.refs.some(r=>r.artifact_id===doc.artifact_id))state.refs.push({item_id:input.item_id,artifact_id:doc.artifact_id!,content_hash:doc.content_hash});
   for(const dependency of doc.dependencies)if(!state.refs.some(r=>r.artifact_id===dependency.artifact_id))state.refs.push(dependency);
   if(state.refs.length>16)throw new HttpError(403,'History dependency scope is too large');
   if(!state.read_ids.includes(input.item_id))state.read_ids.push(input.item_id);
   result={item_id:input.item_id,title:doc.title,source_uri:doc.source_uri,text:doc.plain_text.slice(0,12000),truncated:doc.plain_text.length>12000,provenance:doc.reading_info,read_status:'unknown',acceptance_status:'unknown'};
  }else{
   const issues=[];
   if(!state.searches)issues.push('Search retained history first; an empty eligible result is acceptable.');
   if(state.refs.length&&!state.read_ids.length)issues.push('Read a relevant retained candidate, or explain why candidates do not bear on the questions.');
   // The report, rather than a separate checklist, must contain the substantive findings.
   for(const q of input.questions){
    for(const field of ['finding','explanation','limitations','alternative'] as const)if(!input.draft.includes(q[field]))issues.push(`Include the checked ${field} passage in the report draft; quote that passage in the check record.`);
    for(const url of q.evidence_urls)if(!input.draft.includes(url))issues.push('Cite the checked supporting URLs in the report draft.');
   }
   if(!input.draft.includes(input.historical_comparison))issues.push('Include the historical comparison or its actual limitation in the report.');
   if(!issues.length){state.checked_hash=reportHash(input.draft);state.questions=input.questions;state.historical_comparison=input.historical_comparison;state.remaining_gaps=input.remaining_gaps;state.stop_reason=input.stop_reason;}
   result={ready:issues.length===0,issues,verification:'coverage_only_not_semantic_quality',next:issues.length?'Continue reading, revise the draft, and check again in this Run.':'Submit this exact checked draft as agent_summary; do not shorten it into a different report.'};
  }
  await tx.query(`UPDATE extraction_jobs SET metadata_json=jsonb_set(metadata_json,'{investigation}',$2::jsonb) WHERE id=$1`,[context.id,state]);
  return result;
 });
}

export async function assertInvestigationReport(db:Queryable,config:ServerConfig,run:RunRecord,text:string,lock=false){
 if(!investigationOf(run))return null;
 const context=materialItemContext(run)!;
 const state=(await db.query<{metadata_json:{investigation?:InvestigationState}}>(`SELECT metadata_json FROM extraction_jobs WHERE id=$1 AND space_id=$2`,[context.id,run.space_id])).rows[0]?.metadata_json.investigation;
 if(!state?.checked_hash||state.checked_hash!==reportHash(text))throw new HttpError(422,'Check the complete report with source.material.investigate before submitting; use the same draft text');
 if(lock)await (await import('../../runtimeContext/index.js')).lockSourceReadingReferences(db,run.space_id,state.refs,run.instructed_by_user_id!,context.item_id);
 for(const ref of state.refs){const doc=await historyDocument(db,config,run,context.item_id,ref.item_id,ref.artifact_id);if(doc.artifact_id!==ref.artifact_id||doc.content_hash!==ref.content_hash)throw new HttpError(409,'Historical material changed; start a fresh investigation');if(doc.source_snapshot_id)ref.snapshot_id=doc.source_snapshot_id;}
 return state;
}
