import {RESEARCH_AGENT_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import type {RunRecord} from '../runs/repository.js';
import {assertProjectWriter,assertProjectWriterForMutation} from '../projects/access.js';
import {assertThreadReadable} from '../inquiry/threadAccess.js';
import {problemCommandKey} from '../inquiry/problemFacts.js';
import {InquiryMutationError} from '../inquiry/operationErrors.js';
import {InquiryThreadService} from '../inquiry/threadService.js';
import {listActiveThreadRefs} from '../inquiry/inquirySystemActionExecutors.js';
import {PgAgentGroupRepository} from '../agentGroups/repository.js';
import {researchMetadataReadableSql} from './researchOperationMetadata.js';
import {ResearchAcquisitionService} from './pipeline/researchAcquisitionService.js';
import {ResearchProblemResultService} from './researchProblemResults.js';
import {assertResearchResultRunEgress} from './researchResultEgress.js';
import {ResearchWorkspaceMutationError} from './workspaceErrors.js';
import {authorizeClosure,discover,type Closure} from './controlOperations.js';

type Id=keyof typeof RESEARCH_AGENT_OPERATION_SCHEMAS;
type Input={thread_id?:string;operation_id?:string;intent_note?:string;max_items?:number;since?:string};
type Receipt={id:string;space_id:string;project_id:string;thread_id:string;operation_id?:string|null;status?:string};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});

/** The live Run binds Project authority; input never selects it. */
async function boundRun(db:Queryable,a:OperationActor,lock=false):Promise<RunRecord&{project_id:string}>{
 if(a.principal.kind!=='agent'||!a.run_id)throw hidden();
 const run=(await db.query<RunRecord>(`SELECT * FROM runs WHERE id=$1 AND space_id=$2 AND agent_id=$3 AND instructed_by_user_id=$4${lock?' FOR SHARE':''}`,[a.run_id,a.space_id,a.agent_id,a.on_behalf_of_user_id])).rows[0];
 if(!run?.project_id)throw hidden();
 return run as RunRecord&{project_id:string};
}
const closureInput=(raw:unknown,projectId:string)=>({project_id:projectId,...((raw as Input).operation_id?{operation_id:(raw as Input).operation_id}:{}),...((raw as Input).thread_id?{thread_id:(raw as Input).thread_id}:{})});

/** Safe hint built only after live Run, Project-writer and visible-Thread filtering. */
class MissingQuestionThread extends OperationError {
 constructor(private readonly hint:string){super('operation_not_found',404,false,'research');}
 override body(requestId:string){const body=super.body(requestId);body.error.message=this.hint;return body;}
}
async function missingThread(db:Queryable,a:OperationActor,projectId:string,threadId:string):Promise<never>{
 // Same text for an unknown, closed or unreachable id: the hint lists only Threads this person can see.
 try{
  await assertProjectWriter(db,a.space_id,projectId,a.on_behalf_of_user_id!);
  const active=await listActiveThreadRefs(new InquiryThreadService(db),person(a),projectId,'question');
  throw new MissingQuestionThread(active.length===0
   ?`No active Question Thread has id '${threadId}', and this Project has no active Question Thread yet — open one with inquiry.create_thread, then start the acquisition on it.`
   :`No active Question Thread has id '${threadId}'. Read inquiry.list_threads for the complete paginated list. First matching ids: ${active.map(thread=>`${thread.thread_id} — ${thread.statement}`).join('; ')}`);
 }catch(error){if(error instanceof MissingQuestionThread)throw error;throw hidden();}
}

/** Existing grant-bound Agent Research tools; the human Research commands' owners, closure locks and domain keys are reused. */
export function researchAgentRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(RESEARCH_AGENT_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,
  successStatus:id==='research.start_acquisition'?202:200,
  policyContext(_raw,_a,scope){return {project_id:(scope.targets as {project_id:string}).project_id,surface:'managed_run_system_action_gateway',tool_name:id};},
  async resolve(db,raw,a){
   const run=await boundRun(db,a),input=closureInput(raw,run.project_id);
   const closure=await discover(db,input,a);
   return {authority:`project:${run.project_id}:run:${a.run_id}`,targets:{project_id:run.project_id,thread_id:(raw as Input).thread_id??null,operation_id:closure.operation},
    resourceType:id==='research.start_acquisition'?'inquiry_thread':'project_operation',resourceId:id==='research.start_acquisition'?(raw as Input).thread_id!:(raw as Input).operation_id!,closure};
  },
  async authorize(db,raw,a,scope){
   const run=await boundRun(db,a,true),targets=scope.targets as {project_id:string};
   if(run.project_id!==targets.project_id)throw new OperationError('operation_conflict',409,false,'research');
   const input=closureInput(raw,run.project_id),closure=(scope as typeof scope&{closure:Closure}).closure;
   try{await authorizeClosure(db,input,a,closure);}
   catch(error){
    if(id==='research.start_acquisition'&&[403,404].includes((error as {statusCode?:number}).statusCode??0))await missingThread(db,a,run.project_id,(raw as Input).thread_id!);
    throw error;
   }
   if(id==='research.adopt_result'){
    // A person's read entitlement is not Source egress into this Run; keep the Run destination gate.
    await new ResearchProblemResultService(db).read(person(a),run.project_id,closure.operation!);
    await assertResearchResultRunEgress(db,run,closure.operation!);
   }
  },
  async authorizeResult(db,raw,a){
   const out=raw as Receipt,run=await boundRun(db,a);
   if(out.space_id!==a.space_id||out.project_id!==run.project_id)throw hidden();
   await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);
   await assertThreadReadable(db,person(a),out.project_id,out.thread_id,'read');
   if(out.operation_id&&!(await db.query(`SELECT op.id FROM project_operations op WHERE op.id=$1 AND op.space_id=$2 AND op.project_id=$3 AND ${researchMetadataReadableSql('op','$4')}`,[out.operation_id,a.space_id,out.project_id,a.on_behalf_of_user_id])).rows.length)throw hidden();
   if(id==='research.adopt_result')await assertResearchResultRunEgress(db,run,out.operation_id!);
  },
  async execute(db,raw,a,invocation){
   if(!invocation?.idempotencyKey)throw new OperationError('idempotency_key_required',422);
   const run=await boundRun(db,a,true),p=person(a),i=raw as Input,base={space_id:a.space_id,project_id:run.project_id};
   if(id==='research.adopt_result'){
    const {operation_id:_operation,...assessment}=raw as Record<string,unknown>;
    const closure=await discover(db,closureInput(raw,run.project_id),a);
    if(!closure.operation||!closure.operation_thread)throw hidden();
    await new ResearchProblemResultService(db).adopt(p,run.project_id,closure.operation,assessment,{runId:run.id,agentId:run.agent_id!});
    return {...base,id:closure.operation_thread,thread_id:closure.operation_thread,operation_id:closure.operation};
   }
   // Room origin comes from the Run's own agent-group membership, never from the tool call.
   const origin=run.run_group_id?await new PgAgentGroupRepository(db).getGroup(run.space_id,run.run_group_id):null;
   let out;
   try{
    out=await new ResearchAcquisitionService(db).startAcquisition(p,run.project_id,{
     requestKey:problemCommandKey(p,invocation.idempotencyKey,{runId:run.id}),originRunId:run.id,threadId:i.thread_id!,intentNote:i.intent_note??null,
     originRoomId:origin?.room_id??null,originSessionId:origin?.session_id??null,originGroupId:origin?.room_id?origin.id:null,
     maxItems:i.max_items??null,since:i.since??null});
   }catch(error){
    if(error instanceof HttpError&&error.statusCode===404)await missingThread(db,a,run.project_id,i.thread_id!);
    throw error;
   }
   return {...base,id:out.operation_id??out.thread_id,thread_id:out.thread_id,operation_id:out.operation_id??null,status:out.status};
  },
  classifyError(error){
   if(error instanceof ResearchWorkspaceMutationError||error instanceof InquiryMutationError)return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode===409?409:422,'research');
   return undefined;
  },
 }));
}
