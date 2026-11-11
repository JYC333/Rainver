import {RESEARCH_CONTROL_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {researchGraphRunRefs} from '../systemActions/operations/proposalTransitions.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {ProjectCorpusRepository} from '../projects/corpusRepository.js';
import {ProjectCorpusMutationError} from '../projects/corpusMutationError.js';
import {assertThreadReadable} from '../inquiry/threadAccess.js';
import {InquiryMutationError} from '../inquiry/operationErrors.js';
import {SourceBackfillMutationError} from '../sources/sourceBackfillErrors.js';
import {researchWorkflowProjection} from './workflowOntology.js';
import {researchMetadataReadableSql} from './researchOperationMetadata.js';
import {assertResearchOperationChange} from './researchCallAccess.js';
import {ProjectResearchOrchestrator} from './orchestrator.js';
import {ProjectResearchRepository} from './repository.js';
import {ProjectResearchStandingComparisonService} from './standingComparisonService.js';
import {ResearchProblemResultService} from './researchProblemResults.js';
import {ResearchAcquisitionService} from './pipeline/researchAcquisitionService.js';
import {ResearchWorkspaceMutationError} from './workspaceErrors.js';
import {ProjectResearchQuestionRefineService} from './questionRefineService.js';
import {researchState} from './operationProjection.js';
import {lockSourceReadClosure} from './researchArtifactClosure.js';
import {sourceItemFullContentReadClause} from '../sources/sourceItemAccess.js';

type Id=keyof typeof RESEARCH_CONTROL_SCHEMAS;
type Input={project_id:string;workflow_id?:string;operation_id?:string;thread_id?:string;report_id?:string;advice_id?:string;checkpoint_id?:string};
type Receipt={id:string;project_id:string;space_id:string;workflow_id?:string|null;operation_id?:string|null;thread_id?:string};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const body=(raw:unknown)=>{const value={...raw as Record<string,unknown>};for(const key of ['project_id','workflow_id','operation_id','checkpoint_id','report_id','advice_id'])delete value[key];return value;};
/** Domain paths that enter withRunTerminalOwner; the host admits that Run set first. */
const RUN_OWNERS=new Set<Id>(['research.intake.start','research.workflow.trigger','research.workflow.history_backfill','research.question.resolve','research.checkpoint.decide','research.operation.retry','research.operation.reconcile']);
const CREATED=new Set<Id>(['research.intake.start','research.result.adopt','research.standing.action','research.report.integrity']);
const QUEUED=new Set<Id>(['research.question.refine','research.workflow.trigger','research.workflow.history_backfill','research.operation.retry','research.operation.rescan','research.acquisition.start']);

/** Read-only discovery of the Workflow/Thread/Operation closure; locks follow in authorize. */
export async function discover(db:Queryable,i:Input,a:OperationActor){
 const operation=i.operation_id?(await db.query<{id:string;workflow_id:string|null;thread_id:string|null}>("SELECT id,progress_json->>'workflow_id' AS workflow_id,research_call_json->>'thread_id' AS thread_id FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3 AND kind='research'",[i.operation_id,a.space_id,i.project_id])).rows[0]??null:null;
 if(i.operation_id&&!operation)throw hidden();
 const report=i.report_id?(await db.query<{workflow_id:string}>('SELECT workflow_id FROM project_research_reports WHERE id=$1 AND space_id=$2 AND project_id=$3',[i.report_id,a.space_id,i.project_id])).rows[0]??null:null;
 if(i.report_id&&!report)throw hidden();
 const workflowId=i.workflow_id??operation?.workflow_id??report?.workflow_id??null;
 const workflow=workflowId?(await db.query<{primary_thread_id:string|null}>(`SELECT pin.primary_thread_id FROM ${researchWorkflowProjection().from} WHERE w.object_id=$1 AND w.space_id=$2 AND w.project_id=$3`,[workflowId,a.space_id,i.project_id])).rows[0]??null:null;
 if(i.workflow_id&&!workflow)throw hidden();
 const threads=[...new Set([i.thread_id,operation?.thread_id,workflow?.primary_thread_id].filter((v):v is string=>!!v))].sort();
 return {operation:operation?.id??null,operation_thread:operation?.thread_id??null,workflow:workflow?workflowId:null,threads};
}
export type Closure=Awaited<ReturnType<typeof discover>>;

export async function authorizeClosure(db:Queryable,i:Input,a:OperationActor,before:Closure){
 const p=person(a);
 await assertProjectWriter(db,a.space_id,i.project_id,p.userId,{allowArchived:true});
 try{await lockActiveProjectForMutation(db,a.space_id,i.project_id);}catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'research');throw e;}
 await assertProjectWriterForMutation(db,a.space_id,i.project_id,p.userId);
 await db.query('SELECT id FROM project_members WHERE space_id=$1 AND project_id=$2 AND user_id=$3 FOR SHARE',[a.space_id,i.project_id,p.userId]);
 const roots=[...new Set([before.workflow,...before.threads].filter((v):v is string=>!!v))].sort();
 if(roots.length){
  await db.query('SELECT id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR UPDATE',[a.space_id,roots]);
  await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,roots]);
 }
 if(before.workflow){
  const projection=researchWorkflowProjection({viewerPlaceholder:'$4'});
  if(!(await db.query(`SELECT w.object_id FROM ${projection.from} WHERE w.object_id=$1 AND w.space_id=$2 AND w.project_id=$3 AND ${projection.visibilityPredicate} FOR UPDATE OF w`,[before.workflow,a.space_id,i.project_id,p.userId])).rows.length)throw hidden();
 }
 for(const thread of before.threads)await assertThreadReadable(db,p,i.project_id,thread,'change');
 if(before.operation){
  await db.query('SELECT id FROM project_operations WHERE id=$1 AND space_id=$2 FOR UPDATE',[before.operation,a.space_id]);
  await assertResearchOperationChange(db,p,i.project_id,before.operation);
 }
 if(i.report_id)await db.query('SELECT id FROM project_research_reports WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[i.report_id,a.space_id,i.project_id]);
 if(i.checkpoint_id&&!(await db.query('SELECT id FROM project_research_checkpoints WHERE id=$1 AND space_id=$2 AND project_id=$3 AND workflow_id=$4 FOR UPDATE',[i.checkpoint_id,a.space_id,i.project_id,i.workflow_id])).rows.length)throw hidden();
 if(i.advice_id&&!(await db.query('SELECT id FROM project_research_standing_advice WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[i.advice_id,a.space_id,i.project_id])).rows.length)throw hidden();
 // A closure that changed while waiting is a conflict; never extend locks late.
 if(canonical(await discover(db,i,a))!==canonical(before))throw new OperationError('operation_conflict',409,false,'research');
}

async function execute(id:Id,db:Queryable,raw:unknown,a:OperationActor,config:ServerConfig,before:Closure):Promise<Record<string,unknown>>{
 const i=raw as Input,p=person(a),base={project_id:i.project_id,space_id:a.space_id},research=new ProjectResearchOrchestrator(db,config),input=body(raw);
 const operationReceipt=(row:{id?:unknown})=>({...base,id:String(row.id)});
 switch(id){
  case 'research.intake.start':{
   const started=await research.startInitialIntake(p,i.project_id,{...input,...(i.workflow_id?{workflow_id:i.workflow_id}:{})}) as unknown as {workflow?:{id:string}|null;operation:{id:string};source_channels:{id:unknown}[];source_bindings:{id:unknown}[]};
   return {...base,id:started.operation.id,workflow_id:started.workflow?.id??null,source_channel_ids:started.source_channels.map(c=>String(c.id)),source_binding_ids:started.source_bindings.map(b=>String(b.id))};
  }
  case 'research.workflow.trigger':{
   const b=raw as {source_item_ids?:string[];idempotency_key?:string};
   return operationReceipt(await research.triggerIncremental(p,i.project_id,i.workflow_id!,{...(b.source_item_ids?{source_item_ids:b.source_item_ids}:{}),...(b.idempotency_key?{idempotency_key:b.idempotency_key}:{})}));
  }
  case 'research.workflow.history_backfill':return operationReceipt(await research.startHistoricalBackfill(p,i.project_id,i.workflow_id!,input));
  case 'research.question.resolve':{
   const resolved=await research.resolveQuestionChange(p,i.project_id,i.workflow_id!,input.strategy as 'rescreen'|'synthesis_only'|'apply_forward') as {id?:string;workflow?:{id:string};operation?:{id:string}};
   return {...base,id:String(resolved.workflow?.id??resolved.id),operation_id:resolved.operation?.id??null};
  }
  case 'research.checkpoint.decide':{const checkpoint=await research.decideCheckpoint(p,i.project_id,i.workflow_id!,i.checkpoint_id!,input);return {...base,id:String(checkpoint.id),workflow_id:i.workflow_id!};}
  case 'research.operation.retry':return operationReceipt(await research.retryFailedOperation(p,i.project_id,i.operation_id!));
  case 'research.operation.reconcile':{const out=await research.reconcileOperationForUser(p,i.project_id,i.operation_id!);return {...base,id:out.id,before_status:out.reconcile_diagnostic.before_status,after_status:out.reconcile_diagnostic.after_status};}
  case 'research.operation.item_limit':return operationReceipt(await research.updateItemLimit(p,i.project_id,i.operation_id!,input));
  case 'research.operation.rescan':return operationReceipt(await research.rescanEmptyBackfill(p,i.project_id,i.operation_id!,{}));
  case 'research.result.adopt':{await new ResearchProblemResultService(db).adopt(p,i.project_id,i.operation_id!,input);const thread=before.operation_thread;if(!thread)throw hidden();return {...base,id:thread,thread_id:thread};}
  case 'research.acquisition.start':{
   const b=raw as {thread_id:string;idempotency_key:string;intent_note:string;max_items?:number;since?:string};
   const out=await new ResearchAcquisitionService(db).startAcquisition(p,i.project_id,{threadId:b.thread_id,requestKey:`human:${p.userId}:${b.idempotency_key}`,intentNote:b.intent_note,...(b.max_items===undefined?{}:{maxItems:b.max_items}),...(b.since?{since:b.since}:{}),originRoomId:null,originSessionId:null});
   return {...base,id:out.operation_id??b.thread_id,thread_id:b.thread_id,status:out.status};
  }
  case 'research.standing.action':{const out=await new ProjectResearchStandingComparisonService(db,config).actionAdvice(p,i.project_id,i.advice_id!) as {thread:{id:string}};return {...base,id:i.advice_id!,thread_id:String(out.thread.id)};}
  case 'research.report.integrity':{await new ProjectResearchRepository(db).runReportIntegrity(p,i.project_id,i.report_id!);return {...base,id:i.report_id!,report_id:i.report_id!};}
  case 'research.question.refine':{const out=await new ProjectResearchQuestionRefineService(db,config).admitRefine(p,i.project_id,input);return {...base,id:out.messageId,thread_id:i.thread_id!,session_id:out.sessionId,job_id:out.jobId};}
  case 'project.corpus.backfill_sources':{const out=await new ProjectCorpusRepository(db).backfillFromSources(p,i.project_id);return {...out,space_id:a.space_id};}
 }
}

/**
 * Items a person names for an incremental update must be ones the Workflow's
 * own monitors scanned (their connection is one of its channels') and still
 * readable to that person in full, since screening reads their content. The
 * Source closure is share-locked in Notebook admission's order after the
 * Workflow row, so a revocation either commits first and is refused here or
 * waits for this admission. Unknown, foreign and unreadable items look alike.
 */
async function assertTriggerSourceItems(db:Queryable,a:OperationActor,projectId:string,workflowId:string,itemIds:readonly string[]){
 const ids=[...new Set(itemIds)].sort();if(!ids.length)return;
 const workflow=(await db.query<{state_json:unknown}>('SELECT state_json FROM project_research_workflows WHERE object_id=$1 AND space_id=$2 AND project_id=$3',[workflowId,a.space_id,projectId])).rows[0];
 if(!workflow)throw hidden();
 const channels=researchState(workflow.state_json).channel_ids??[];
 const connections=channels.length?(await db.query<{id:string}>('SELECT DISTINCT source_connection_id AS id FROM source_channels WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY 1',[a.space_id,channels])).rows.map(r=>r.id):[];
 if(!connections.length)throw hidden();
 await lockSourceReadClosure(db,a.space_id,a.on_behalf_of_user_id!,connections,ids);
 const readable=await db.query(`SELECT item.id FROM source_items item WHERE item.space_id=$1 AND item.id=ANY($2::varchar[]) AND item.deleted_at IS NULL AND item.connection_id=ANY($3::varchar[]) AND ${sourceItemFullContentReadClause('item','$4')}`,[a.space_id,ids,connections,a.on_behalf_of_user_id]);
 if(readable.rows.length!==ids.length)throw hidden();
}

/** Human-only Research/Corpus controls. Durable effects stay with the existing domain writers and Jobs. */
export function researchControlRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return (Object.keys(RESEARCH_CONTROL_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,
  successStatus:CREATED.has(id)?201:QUEUED.has(id)?202:200,
  ...(RUN_OWNERS.has(id)?{runTerminalOwner:{discover:(db:Queryable,raw:unknown,a:OperationActor)=>researchGraphRunRefs(db,a.space_id,(raw as Input).project_id)}}:{}),
  async resolve(db,raw,a){const i=raw as Input,closure=await discover(db,i,a);
   const resourceType=id==='research.acquisition.start'?'inquiry_thread':i.operation_id?'project_operation':'project';
   return {authority:`project:${i.project_id}`,resourceType,resourceId:id==='research.acquisition.start'?i.thread_id!:i.operation_id??i.project_id,
    targets:{project_id:i.project_id,workflow_id:closure.workflow,operation_id:closure.operation,thread_ids:closure.threads,report_id:i.report_id??null,checkpoint_id:i.checkpoint_id??null,advice_id:i.advice_id??null},closure};},
  // An explicit empty item list is the omitted one (scan the channels first): one request fingerprint, one transport replay.
  ...(id==='research.workflow.trigger'?{normalizeInput:(raw:unknown)=>{const {source_item_ids,...rest}=raw as Record<string,unknown>;return Array.isArray(source_item_ids)&&source_item_ids.length?{...rest,source_item_ids}:rest;}}:{}),
  async authorize(db,raw,a,scope){const i=raw as Input;await authorizeClosure(db,i,a,(scope as typeof scope&{closure:Closure}).closure);
   // The assessment conversation is Thread content, as for its confirmation.
   if(id==='research.workflow.trigger')await assertTriggerSourceItems(db,a,i.project_id,i.workflow_id!,(raw as {source_item_ids?:string[]}).source_item_ids??[]);
   if(id==='research.question.refine'){await assertThreadReadable(db,person(a),i.project_id,i.thread_id!,'read_content');await db.query('SELECT id FROM project_research_question_assessment_sessions WHERE space_id=$1 AND project_id=$2 AND thread_id=$3 FOR UPDATE',[a.space_id,i.project_id,i.thread_id]);}
  },
  async authorizeResult(db,raw,a){
   const out=raw as Receipt;if(out.space_id!==a.space_id)throw hidden();
   await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);
   const p=person(a),operation=id==='research.acquisition.start'&&out.id===out.thread_id?null:id==='research.acquisition.start'||id==='research.intake.start'||id==='research.workflow.trigger'||id==='research.workflow.history_backfill'||id.startsWith('research.operation.')?out.id:out.operation_id??null;
   if(operation&&!(await db.query(`SELECT op.id FROM project_operations op WHERE op.id=$1 AND op.space_id=$2 AND op.project_id=$3 AND ${researchMetadataReadableSql('op','$4')}`,[operation,a.space_id,out.project_id,p.userId])).rows.length)throw hidden();
   const workflow=id==='research.question.resolve'?out.id:out.workflow_id??null;
   if(workflow){const projection=researchWorkflowProjection({viewerPlaceholder:'$4'});if(!(await db.query(`SELECT w.object_id FROM ${projection.from} WHERE w.object_id=$1 AND w.space_id=$2 AND w.project_id=$3 AND ${projection.visibilityPredicate}`,[workflow,a.space_id,out.project_id,p.userId])).rows.length)throw hidden();}
   if(out.thread_id)await assertThreadReadable(db,p,out.project_id,out.thread_id,'read');
   if(id==='research.question.refine'){const r=out as Receipt&{session_id:string};await assertThreadReadable(db,p,out.project_id,out.thread_id!,'read_content');if(!(await db.query('SELECT m.id FROM project_research_question_assessment_messages m JOIN project_research_question_assessment_sessions s ON s.id=m.session_id AND s.space_id=m.space_id WHERE m.id=$1 AND m.session_id=$2 AND m.space_id=$3 AND s.thread_id=$4',[out.id,r.session_id,a.space_id,out.thread_id])).rows.length)throw hidden();}
  },
  async execute(db,raw,a){const closure=await discover(db,raw as Input,a);return execute(id,db,raw,a,config,closure);},
  classifyError(e){
   if(e instanceof ResearchWorkspaceMutationError||e instanceof InquiryMutationError||e instanceof SourceBackfillMutationError||e instanceof ProjectCorpusMutationError)return new OperationBusinessError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode===409?409:422,id==='project.corpus.backfill_sources'?'projects':'research');
   return undefined;
  },
 }));
}
