import { acceptedThreadContext } from "./acceptedThreadContext.js";
import { ResearchContextRepository } from "./question/researchContextRepository.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { createResearchWorkflow,pinnedResearchThreadId } from "./workflowOntology.js";
import { assertProblemReferences } from "../inquiry/problemReferences.js";
import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { randomUUID, createHash } from "node:crypto";
import { ResearchCallSchema, ResearchCallOptionsSchema, type ResearchCall } from "@rainver/protocol";
import { HttpError, objectValue, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { ProjectOperationService } from "../projects/projectOperationService.js";
import { assertProjectWriter, lockActiveProjectForMutation } from "../projects/access.js";
import { lockProblem, problemRound, refreshProblem } from "../inquiry/problemFacts.js";
import { recordThreadWorkEvent } from "../inquiry/threadWorkEvents.js";
import { researchState } from "./operationProjection.js";
import { researchPositionHash, assertResearchCallReadable } from "./researchCallAccess.js";
type ManagedInput=Parameters<ProjectOperationService["createManagedResearch"]>[2];
/** Admission owns the transaction: execution row, snapshot and originating Step
 * either all exist or none do. No query by kind can identify a logical call. */
export async function createBoundResearchOperation(db:Queryable,identity:SpaceUserIdentity,projectId:string,input:ManagedInput):Promise<{id:string}>{
 return withQueryableTransaction(db,async tx=>{
  const state=researchState(input.progress),pin=state.thread_scope?.[0];
  if(!pin||state.run_kind==="incremental")return new ProjectOperationService(tx).createManagedResearch(identity,projectId,input); // Independent Research and incremental monitoring need no problem call.
  const thread=await lockProblem(tx,identity,projectId,pin.thread_id);
  if(thread.blocked_reason)throw new HttpError(409,"Unblock the Thread before invoking Research");
  if(thread.version!==pin.version)throw new HttpError(409,"Research input no longer matches the Thread revision");
  const linked=await pinnedResearchThreadId(tx,{spaceId:identity.spaceId,projectId,workflowId:state.workflow_id});
  if(linked!==pin.thread_id||await contentDecisionFromDb(tx,identity,"space_object",state.workflow_id)!=="full")throw new HttpError(404,"Research Workflow does not match the problem snapshot");
  const options=state.problem_call?ResearchCallOptionsSchema.parse(state.problem_call):null;
  if(options?.expected_version!==undefined&&options.expected_version!==thread.version||options?.expected_revision!==undefined&&options.expected_revision!==thread.problem_revision)throw new HttpError(409,"Research input problem revision changed");
  await assertProblemReferences(tx,identity,projectId,options?.input_refs??[]);
  const key=`user:${identity.userId}:thread:${pin.thread_id}:`+createHash("sha256").update(state.idempotency.key).digest("hex");
  const prior=await tx.query<{id:string;research_call_json:unknown;progress_json:unknown}>(`SELECT id,research_call_json,progress_json FROM project_operations WHERE space_id=$1 AND project_id=$2 AND research_call_key=$3 FOR UPDATE`,[identity.spaceId,projectId,key]);
  if(prior.rows[0]){
   const call=await assertResearchCallReadable(tx,identity,projectId,prior.rows[0].research_call_json,prior.rows[0].progress_json);
   if(call?.thread_id!==pin.thread_id||objectValue(objectValue(prior.rows[0].progress_json).idempotency).fingerprint!==state.idempotency.fingerprint)throw new HttpError(409,"Research call key already used for different input");
   return {id:prior.rows[0].id};
  }
  const created=await new ProjectOperationService(tx).createManagedResearch(identity,projectId,input);
  const round=await problemRound(tx,identity.spaceId,pin.thread_id);
  const origin=await tx.query<{id:string;method_stage:string|null}>(`SELECT id,method_stage FROM inquiry_thread_steps WHERE thread_id=$1 AND space_id=$2 AND slot='primary' AND status='in_progress'`,[pin.thread_id,identity.spaceId]);
  const boundary=await tx.query<{id:string}>(`SELECT id FROM inquiry_round_closeouts WHERE thread_id=$1 AND space_id=$2 ORDER BY round_number DESC LIMIT 1`,[pin.thread_id,identity.spaceId]);
  const stepId=randomUUID(),now=new Date().toISOString();
  const call:ResearchCall=ResearchCallSchema.parse({schema_version:"research_call.v1",operation_id:created.id,workflow_id:state.workflow_id,thread_id:pin.thread_id,thread_version:pin.version,problem_revision:thread.problem_revision,round_number:round,round_start_id:boundary.rows[0]?.id??null,step_id:stepId,source_step_id:origin.rows[0]?.id??null,position_hash:await researchPositionHash(tx,identity.spaceId,pin.thread_id),stage:options?.stage??origin.rows[0]?.method_stage??"act",gap:options?.gap??(input.intentText||pin.statement).slice(0,4000),input_refs:options?.input_refs??[],output_expectation:options?.output_expectation??"Find evidence, counterevidence, limitations and remaining gaps; return reports for explicit assessment.",scope:{context_version_id:state.preparation_context_version_id??null,providers:state.preparation_providers??[],source_channel_ids:state.channel_ids,history:state.history,research_scope:state.research_scope},requested_by_user_id:identity.userId,requested_by_run_id:state.origin_run_id??null});
  await tx.query(`INSERT INTO inquiry_thread_steps(id,space_id,project_id,thread_id,kind,method_version,method_stage,work_kind,round_number,status,slot,note,target_ref_kind,target_ref_id,origin,context_refs,started_at,created_at) VALUES($1,$2,$3,$4,'invoke_research','problem_solving.v1',$5,'invoke_research',$6,'in_progress','background',$7,'research_operation',$8,'system',$10::jsonb,$9,$9)`,[stepId,identity.spaceId,projectId,pin.thread_id,call.stage,round,call.gap,created.id,now,JSON.stringify(call.input_refs.map(ref=>({role:"input",ref})))]);
  await tx.query(`UPDATE project_operations SET research_call_json=$3::jsonb,research_step_id=$4,research_call_key=$5 WHERE id=$1 AND space_id=$2`,[created.id,identity.spaceId,JSON.stringify(call),stepId,key]);
  await refreshProblem(tx,identity.spaceId,pin.thread_id);
  await recordThreadWorkEvent(tx,{spaceId:identity.spaceId,projectId,threadId:pin.thread_id,userId:identity.userId,eventKind:"thread.work_recorded",occurredAt:now,idempotencySuffix:stepId,provenance:state.origin_run_id?{runId:state.origin_run_id,agentId:state.agent_id}:undefined,data:{statement:thread.statement,summary:"Research capability admitted",step_id:stepId,operation_id:created.id,reference_refs:call.input_refs,method_version:"problem_solving.v1"}});
  if(input.status==="failed")await reconcileResearchCall(tx,identity.spaceId,created.id);
  return created;
 });
}
/** Called after durable execution transitions and by the existing recovery entry.
 * Re-read the current attempt under lock: stale callback payload is never truth. */
export async function reconcileResearchCall(db:Queryable,spaceId:string,operationId:string):Promise<{status:string}>{
 const ownsTransaction=typeof (db as {connect?:unknown}).connect==='function'&&typeof (db as {release?:unknown}).release!=='function';
 try {
 return await withQueryableTransaction(db,async tx=>{
  const scope=await tx.query<{project_id:string;bound:boolean}>(`SELECT project_id,research_call_json IS NOT NULL AS bound FROM project_operations WHERE id=$1 AND space_id=$2`,[operationId,spaceId]);
  if(!scope.rows[0])throw new HttpError(404,"Research operation not found");
  // Contextual Thread references do not establish an invocation binding.
  // Independent Research and monitoring are first-class, not problem calls.
  // The binding is written once at admission, so this unlocked read is stable.
  if(!scope.rows[0].bound)return {status:'not_problem_call'};
  // Settling an admitted execution is not a user mutation: an archived Project
  // still records how its in-flight call ended. Keep the Project-first lock order.
  const project=await tx.query(`SELECT id FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE`,[scope.rows[0].project_id,spaceId]);
  if(!project.rowCount)throw new HttpError(404,"Project not found");
  const rows=await tx.query<{research_call_json:unknown;research_step_id:string|null;status:string;research_attempt:number;current_execution_id:string|null;research_reconcile_json:unknown;progress_json:unknown}>(`SELECT research_call_json,research_step_id,status,research_attempt,current_execution_id,research_reconcile_json,progress_json FROM project_operations WHERE id=$1 AND space_id=$2 FOR UPDATE`,[operationId,spaceId]);
  const op=rows.rows[0]!;
  const metadata=objectValue(op.progress_json);
  if(metadata.acquisition_preflight===true&&op.status==='active'){
   const job=await tx.query<{status:string}>(`SELECT status FROM jobs WHERE id=$1 AND space_id=$2 AND payload_json->>'operation_id'=$3`,[metadata.acquisition_job_id??null,spaceId,operationId]);
   if(!job.rows[0])throw new HttpError(409,"Research preparation execution binding is unresolved");
   if(['failed','cancelled'].includes(job.rows[0].status)){
    await tx.query(`UPDATE project_operations SET status='failed',version=version+1,progress_json=progress_json||jsonb_build_object('current_stage','failed','stage_state','failed','failed_stage','monitor_setup','error',jsonb_build_object('code','preparation_execution_ended','message','The bound preparation execution ended without admission')) WHERE id=$1 AND space_id=$2 AND status='active'`,[operationId,spaceId]);
    op.status='failed';
   }
  }
  const call=ResearchCallSchema.parse(op.research_call_json);
  if(call.operation_id!==operationId||call.step_id!==op.research_step_id)throw new HttpError(409,"Research call binding is inconsistent");
  const receipt={status:"reconciled",operation_status:op.status,attempt:op.research_attempt,execution_id:op.current_execution_id};
  const old=objectValue(op.research_reconcile_json);
  const stepStatus=op.status==="completed"?"done":["failed","cancelled"].includes(op.status)?"abandoned":"in_progress";
  const bound=await tx.query<{status:string}>(`SELECT status FROM inquiry_thread_steps WHERE id=$1 AND space_id=$2 AND thread_id=$3 AND round_number=$4 AND slot='background' AND method_version='problem_solving.v1' AND work_kind='invoke_research' AND method_stage=$5 AND target_ref_kind='research_operation' AND target_ref_id=$6 FOR UPDATE`,[call.step_id,spaceId,call.thread_id,call.round_number,call.stage,operationId]);
  if(bound.rowCount!==1)throw new HttpError(409,"Research Step binding could not be reconciled");
  if(old.status==='reconciled'&&old.operation_status===op.status&&old.attempt===op.research_attempt&&old.execution_id===op.current_execution_id&&bound.rows[0]?.status===stepStatus)return {status:'reconciled'};
  // Execution bookkeeping (a new pass, attempt or Operation sub-status) is not
  // problem work and must not invalidate readers' revision tokens. Only a
  // settled or reopened invocation Step changes the problem.
  if(bound.rows[0]!.status!==stepStatus){
   const result=await tx.query(`UPDATE inquiry_thread_steps SET status=$5,completed_at=CASE WHEN $5::varchar='in_progress' THEN NULL ELSE now() END,ended_reason=CASE WHEN $5::varchar='in_progress' THEN NULL ELSE $6 END WHERE id=$1 AND space_id=$2 AND thread_id=$3 AND round_number=$4 AND target_ref_kind='research_operation' AND target_ref_id=$7 RETURNING id`,[call.step_id,spaceId,call.thread_id,call.round_number,stepStatus,op.status,operationId]);
   if(result.rowCount!==1)throw new HttpError(409,"Research Step binding could not be reconciled");
   await refreshProblem(tx,spaceId,call.thread_id);
  }
  await tx.query(`UPDATE project_operations SET research_reconcile_json=$3::jsonb WHERE id=$1 AND space_id=$2`,[operationId,spaceId,JSON.stringify(receipt)]);
  return {status:"reconciled"};
 });
 }catch(error){
  // Only our outer Pool boundary has completed rollback here. A nested client
  // may be aborted; its owner/Job records the failure after its own rollback.
  if(ownsTransaction){try{
   await db.query(`UPDATE project_operations SET research_reconcile_json=jsonb_build_object('status','pending','diagnostic','bound_step_reconciliation_failed') WHERE id=$1 AND space_id=$2 AND research_call_json IS NOT NULL`,[operationId,spaceId]);
  }catch{process.stderr.write("[research-call] reconciliation diagnostic could not be persisted\n");}}
  throw error;
 }
}

/** A setup retry retains the original Operation and logical binding. The
 * governing retry Execution has already claimed this attempt under the Project
 * lock; Source provisioning still runs in its ordinary admission transaction. */
export async function resumeResearchSetup(db:Queryable,identity:SpaceUserIdentity,projectId:string,operationId:string,state:Record<string,unknown>,preparationJobId?:string):Promise<{id:string}>{
 await assertProjectWriter(db,identity.spaceId,projectId,identity.userId);
 return withQueryableTransaction(db,async tx=>{
  await lockActiveProjectForMutation(tx,identity.spaceId,projectId);
  const r=await tx.query<{status:string;version:number;research_call_json:unknown;progress_json:unknown}>(`SELECT status,version,research_call_json,progress_json FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3 AND kind='research' FOR UPDATE`,[operationId,identity.spaceId,projectId]);
  const row=r.rows[0];if(!row||!(row.status==='failed'||row.status==='active'&&objectValue(row.progress_json).acquisition_preflight===true))throw new HttpError(409,"Only the original failed setup can be resumed");
  const call=await assertResearchCallReadable(tx,identity,projectId,row.research_call_json,row.progress_json);
  if(call&&call.thread_version!==researchState(state).thread_scope[0]?.version)throw new HttpError(409,"The initiating problem snapshot changed before admission");
  if(preparationJobId&&objectValue(row.progress_json).acquisition_job_id!==preparationJobId)throw new HttpError(409,"Preparation attempt was superseded");
  const previous=researchState(row.progress_json);
  await new ProjectOperationService(tx).setManagedState(identity.spaceId,projectId,operationId,{status:'active',expectedVersion:row.version,replaceProgress:true,progress:{...state,idempotency:previous.idempotency}});
  await reconcileResearchCall(tx,identity.spaceId,operationId);
  return {id:operationId};
 });
}

/** Queue admission is already a logical invocation: planning uses the same
 * Workflow/Operation/Step that material intake will later continue. */
export async function prepareResearchAcquisition(db:Queryable,identity:SpaceUserIdentity,projectId:string,input:{threadId:string;key:string;fingerprint:string;gap:string;maxItems:number;since:string|null;runId?:string|null}):Promise<{id:string}>{
 const thread=await lockProblem(db,identity,projectId,input.threadId);
 const workflowRows=await db.query<{id:string}>(`SELECT w.object_id AS id FROM project_research_workflows w JOIN object_relations rel ON rel.from_object_id=w.object_id AND rel.space_id=w.space_id AND rel.to_object_id=$3 AND rel.link_type='about' AND rel.status='active' AND rel.metadata_json->>'relation_role'='primary_inquiry_thread' WHERE w.space_id=$1 AND w.project_id=$2 ORDER BY w.object_id LIMIT 1`,[identity.spaceId,projectId,input.threadId]);
 const workflowId=workflowRows.rows[0]?.id??randomUUID();
 if(!workflowRows.rows[0])await createResearchWorkflow(db,{id:workflowId,spaceId:identity.spaceId,projectId,title:'Research workflow',status:'not_started',state:{research_question:thread.statement,thread_scope:[{thread_id:input.threadId,version:thread.version,kind:'question',statement:thread.statement}]},startedByUserId:identity.userId,startedRunId:input.runId??null,primaryThreadId:input.threadId,now:new Date().toISOString()});
 const contextId=await acceptedThreadContext(db,identity,projectId,input.threadId);
 const context=await new ResearchContextRepository(db).get(identity.spaceId,projectId,contextId);
 return createBoundResearchOperation(db,identity,projectId,{title:'Research acquisition',intentText:input.gap,status:'active',steps:[],progress:{schema_version:'project_research_operation.v1',run_kind:'baseline',acquisition_preflight:true,preparation_context_version_id:contextId,preparation_providers:['arxiv','openalex'],research_scope:{sub_questions:context?.context.sub_questions??[],in:context?.context.in_scope??[],out:context?.context.out_of_scope??[],must_have:context?.context.must_have??[],nice_to_have:context?.context.nice_to_have??[]},origin_run_id:input.runId??null,workflow_id:workflowId,thread_scope:[{thread_id:input.threadId,version:thread.version,kind:'question',statement:thread.statement}],history:{max_items:input.maxItems,from:input.since,to:null},current_stage:'monitor_setup',stage_state:'running',channel_ids:[],idempotency:{key:input.key,fingerprint:input.fingerprint}}});
}

/** Pre-intake preparation already has a durable Job execution. Retrying that
 * phase reuses the call and Step, creates one new Job attempt and CAS-binds it;
 * it does not need a parallel workflow executor before sources are admitted. */
export async function retryResearchPreparation(db:Queryable,identity:SpaceUserIdentity,projectId:string,operationId:string):Promise<void>{
 await assertProjectWriter(db,identity.spaceId,projectId,identity.userId);
 await withQueryableTransaction(db,async tx=>{
  await lockActiveProjectForMutation(tx,identity.spaceId,projectId);
  const r=await tx.query<{status:string;version:number;progress_json:unknown;research_call_json:unknown}>(`SELECT status,version,progress_json,research_call_json FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE`,[operationId,identity.spaceId,projectId]);
  const row=r.rows[0];if(!row)throw new HttpError(404,"Research operation not found");
  const call=await assertResearchCallReadable(tx,identity,projectId,row.research_call_json,row.progress_json);
  if(!call||objectValue(row.progress_json).acquisition_preflight!==true)throw new HttpError(409,"This is not a preparation retry");
  if(row.status==='active')return;
  if(row.status!=='failed')throw new HttpError(409,"Only failed preparation can retry");
  const problem=await lockProblem(tx,identity,projectId,call.thread_id);
  if(problem.version!==call.thread_version)throw new HttpError(409,"Research input snapshot changed; start a new invocation explicitly");
  const jobs=await tx.query<{payload_json:Record<string,unknown>}>(`SELECT j.payload_json FROM jobs j JOIN project_operation_links l ON l.target_type='job' AND l.target_id=j.id AND l.space_id=j.space_id WHERE l.operation_id=$1 AND l.space_id=$2 AND j.job_type='research_pipeline_start' ORDER BY j.created_at DESC LIMIT 1`,[operationId,identity.spaceId]);
  if(!jobs.rows[0])throw new HttpError(409,"Original preparation execution is unresolved");
  const payload={...jobs.rows[0].payload_json};delete payload.pipeline_outcome;
  const job=await new PgJobQueueRepository(tx).enqueue({job_type:'research_pipeline_start',space_id:identity.spaceId,user_id:identity.userId,payload});
  const progress={...objectValue(row.progress_json),current_stage:'monitor_setup',stage_state:'running',error:undefined,failed_stage:undefined,acquisition_job_id:job.id};
  await new ProjectOperationService(tx).setManagedState(identity.spaceId,projectId,operationId,{status:'active',expectedVersion:row.version,replaceProgress:true,progress});
  await tx.query(`UPDATE project_operations SET research_attempt=research_attempt+1 WHERE id=$1 AND space_id=$2`,[operationId,identity.spaceId]);
  await new ProjectOperationService(tx).link(identity.spaceId,projectId,operationId,'job',job.id,'acquisition_pipeline');
  await reconcileResearchCall(tx,identity.spaceId,operationId);
 });
}
