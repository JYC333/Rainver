import {createHash} from 'node:crypto';
import {INQUIRY_AGENT_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,OperationBusinessError,OperationError} from '../systemActions/operations/errors.js';
import {authorizeInquiry,assertInquiryTask,discoverInquiry,inquiryPerson,type InquiryInput} from './operationAdmission.js';
import {assertThreadReadable} from './threadAccess.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {InquiryMutationError,InquiryTaskFanOutError} from './operationErrors.js';
import {InquiryProblemEngineService} from './problemEngineService.js';
import {InquiryIterationService} from './iterationService.js';
import {InquiryTaskAssociationService} from './taskAssociations.js';
async function binding(db:Queryable,a:OperationActor,lock=false){
 if(a.principal.kind!=='agent'||!a.run_id)throw hidden();
 const run=(await db.query<{project_id:string|null}>('SELECT project_id FROM runs WHERE id=$1 AND space_id=$2 AND agent_id=$3 AND instructed_by_user_id=$4',[a.run_id,a.space_id,a.agent_id,a.on_behalf_of_user_id])).rows[0];if(!run?.project_id)throw hidden();
 const attempt=(await db.query<{attempt_number:number}>(`SELECT attempt_number FROM run_attempts WHERE run_id=$1 AND space_id=$2 ORDER BY attempt_number DESC LIMIT 1${lock?' FOR SHARE':''}`,[a.run_id,a.space_id])).rows[0]?.attempt_number??1;
 return {project_id:run.project_id,attempt};
}
const humanId:Record<keyof typeof INQUIRY_AGENT_OPERATION_SCHEMAS,string>={'inquiry.record_work':'inquiry.problem.record_work','inquiry.close_round':'inquiry.problem.close_round','inquiry.record_conclusion':'inquiry.iteration.record','inquiry.link_task':'inquiry.task.link','inquiry.reference_task_result':'inquiry.task.reference_result'};
/** Existing grant-bound Agent commands; the same core owns policy, audit and transactions. */
export function inquiryAgentOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(INQUIRY_AGENT_OPERATION_SCHEMAS) as Array<keyof typeof INQUIRY_AGENT_OPERATION_SCHEMAS>).map(id=>({
  definition:definitions.get(id)!,successStatus:200,
  policyContext(_raw,_actor,scope){return {project_id:(scope.targets as {project_id:string}).project_id,surface:'managed_run_system_action_gateway',tool_name:id};},
  async resolve(db,raw,a){const run=await binding(db,a),input={...raw as InquiryInput,project_id:run.project_id},closure=await discoverInquiry(db,input,a,humanId[id]);return {authority:`project:${run.project_id}:run:${a.run_id}:attempt:${run.attempt}`,targets:{project_id:run.project_id,thread_id:input.thread_id},resourceType:'inquiry_thread',resourceId:input.thread_id!,closure,run};},
  async authorize(db,raw,a,scope){const s=scope as typeof scope&{run:Awaited<ReturnType<typeof binding>>;closure:Awaited<ReturnType<typeof discoverInquiry>>},current=await binding(db,a,true);if(current.project_id!==s.run.project_id||current.attempt!==s.run.attempt)throw new OperationError('operation_conflict',409,false,'inquiry');const input={...raw as InquiryInput,project_id:current.project_id};await authorizeInquiry(db,input,a,humanId[id],s.closure);await assertThreadReadable(db,inquiryPerson(a),current.project_id,input.thread_id!,'read_content');},
  async authorizeResult(db,raw,a){const out=raw as {project_id:string;space_id:string;thread_id:string;task_id?:string},run=await binding(db,a);if(out.space_id!==a.space_id||out.project_id!==run.project_id)throw hidden();await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);await assertThreadReadable(db,inquiryPerson(a),out.project_id,out.thread_id,'change');await assertThreadReadable(db,inquiryPerson(a),out.project_id,out.thread_id,'read_content');if(out.task_id)await assertInquiryTask(db,a.space_id,out.project_id,out.task_id,a.on_behalf_of_user_id!);},
  async execute(db,raw,a,invocation){
   if(!invocation?.idempotencyKey)throw new OperationError('idempotency_key_required',422);
   const run=await binding(db,a,true),person=inquiryPerson(a),body=raw as Record<string,unknown>,{thread_id,task_id,...input}=body,thread=String(thread_id),provenance={runId:a.run_id!,agentId:a.agent_id!},base={space_id:a.space_id,project_id:run.project_id,thread_id:thread};
   const problem=new InquiryProblemEngineService(db);
   if(id==='inquiry.record_work'){await problem.recordWork(person,run.project_id,thread,input,provenance);return {...base,id:thread};}
   if(id==='inquiry.close_round'){const result=await problem.closeRound(person,run.project_id,thread,input,provenance);return {...base,id:result.id,round_number:result.round_number,iteration_id:result.iteration_id};}
   if(id==='inquiry.record_conclusion'){
    const cognitiveKeys=['answer_state','current_answer_summary','known_gaps','answerability','evaluation_state','confidence','confidence_method'];
    if(input.round_intent==='close_round'&&!cognitiveKeys.some(key=>Object.hasOwn(input,key))){const result=await problem.closeRound(person,run.project_id,thread,{method_version:input.method_version,expected_version:input.expected_version,expected_revision:input.expected_revision,idempotency_key:input.idempotency_key,summary:input.change_summary,input_refs:input.input_refs??[],...(input.start_next_primary?{start_next_primary:input.start_next_primary}:{})},provenance);return {...base,iteration_id:null,closeout_id:result.id};}
    const result=await new InquiryIterationService(db).recordIteration(person,run.project_id,thread,{...input,trigger_kind:'agent_conclusion',trigger_ref:a.run_id},provenance);return {...base,iteration_id:result.id,closeout_id:(result.closeout as {id:string}|null)?.id??null};
   }
   const key=invocation.idempotencyKey,trustedCall=`${run.attempt}:${key}`,domainKey=key.length<=100?key:createHash('sha256').update(key).digest('hex'),tasks=new InquiryTaskAssociationService(db);
   if(id==='inquiry.link_task'){try{return {...base,...await tasks.link(person,run.project_id,thread,{...input,...(task_id?{task_id}:{}),idempotency_key:domainKey},provenance,trustedCall)};}catch(error){if(error instanceof InquiryTaskFanOutError)throw new InquiryTaskFanOutOperationError();throw error;}}
   await tasks.referenceResult(person,run.project_id,thread,String(task_id),{...input,idempotency_key:domainKey},provenance,trustedCall);return {...base,id:String(task_id)};
  },
  classifyError(error){if(error instanceof InquiryMutationError)return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode===409?409:422,'inquiry');return undefined;},
 }));
}

class InquiryTaskFanOutOperationError extends OperationError {
 constructor(){super('operation_limit_exceeded',429,false,'inquiry');}
 override body(requestId:string){const result=super.body(requestId);result.error.message='This turn reached the ordinary Task creation ceiling; use an explicitly requested bounded batch for a list';result.error.metadata={code:'task_fan_out_limit',limit:5};return result;}
}
