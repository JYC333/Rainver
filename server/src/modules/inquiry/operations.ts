import {INQUIRY_OPERATION_SCHEMAS,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import {assertProjectReadable,assertProjectWriterForMutation} from '../projects/access.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import {InquiryThreadService} from './threadService.js';
import {InquiryIterationService} from './iterationService.js';
import {InquirySignalService} from './signalService.js';
import {InquiryProblemEngineService} from './problemEngineService.js';
import {InquiryTaskAssociationService} from './taskAssociations.js';
import {InquiryMutationError} from './operationErrors.js';
import {InquiryNoteUnavailable} from './threadCreationAccess.js';
import {authorizeInquiry,discoverInquiry,inquiryPerson,assertInquiryTask,type InquiryInput} from './operationAdmission.js';
/** Human workspace commands retain their distinct domain semantics and writers. */
export function inquiryOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return Object.keys(INQUIRY_OPERATION_SCHEMAS).map(id=>({
  definition:definitions.get(id)!,successStatus:['inquiry.relation.add','inquiry.note.link','inquiry.definition.revise','inquiry.iteration.record','inquiry.problem.record_work','inquiry.problem.close_round','inquiry.task.link','inquiry.task.reference_result','inquiry.signal.create','inquiry.review_packet.open','inquiry.delta_brief.generate'].includes(id)?201:200,
  async resolve(db,raw,a){const i=raw as InquiryInput,closure=await discoverInquiry(db,i,a,id);return {authority:`project:${i.project_id}`,resourceType:'project',resourceId:i.project_id,targets:{project_id:i.project_id,thread_id:i.thread_id??null},closure};},
  async authorize(db,raw,a,scope){return authorizeInquiry(db,raw as InquiryInput,a,id,(scope as typeof scope&{closure:Awaited<ReturnType<typeof discoverInquiry>>}).closure);},
  async authorizeResult(db,raw,a){const out=raw as {project_id:string;space_id:string;task_id?:string};if(out.space_id!==a.space_id)throw hidden();if(out.task_id)await assertInquiryTask(db,a.space_id,out.project_id,out.task_id,a.on_behalf_of_user_id!);if(id==='inquiry.personal_focus.set')await assertProjectReadable(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);else await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);},
  async execute(db,raw,a){
   const i=raw as InquiryInput,body=raw as Record<string,unknown>,person=inquiryPerson(a),thread=new InquiryThreadService(db),iterations=new InquiryIterationService(db),signals=new InquirySignalService(db),problem=new InquiryProblemEngineService(db),tasks=new InquiryTaskAssociationService(db);
   const {project_id,thread_id,task_id,...payload}=body;void project_id;void thread_id;void task_id;
   let result:Record<string,unknown>|undefined;const base={project_id:i.project_id,space_id:a.space_id};
   switch(id){
    case 'inquiry.relation.add':result=await thread.addRelation(person,i.project_id,body);break;
    case 'inquiry.relation.remove':await thread.removeRelation(person,i.project_id,i.relation_id!);return {...base,id:i.relation_id!};
    case 'inquiry.thread.set_primary_parent':result=await thread.setPrimaryParent(person,i.project_id,i.thread_id!,i.parent_thread_id??null);break;
    case 'inquiry.note.link':result=await thread.linkNote(person,i.project_id,i.thread_id!,body);break;
    case 'inquiry.note.unlink':await thread.unlinkNote(person,i.project_id,i.thread_id!,i.note_object_id!);return {...base,id:i.note_object_id!,thread_id:i.thread_id!};
    case 'inquiry.personal_focus.set':await thread.setPersonalFocus(person,i.project_id,i.thread_id!,body.in_focus as boolean);return {...base,id:i.thread_id!,thread_id:i.thread_id!};
    case 'inquiry.shared_focus.configure':return {...base,shared_focus_wip_limit:await thread.setSharedFocusWipLimit(person,i.project_id,body.shared_focus_wip_limit as number)};
    case 'inquiry.definition.revise':{const revised=await iterations.reviseDefinition(person,i.project_id,i.thread_id!,body);return {...base,thread_id:(revised.thread as {id:string}).id,superseded_by_thread_id:revised.superseded_by_thread_id};}
    case 'inquiry.iteration.record':result=await iterations.recordIteration(person,i.project_id,i.thread_id!,payload);break;
    case 'inquiry.work.update':{const work=await iterations.updateWork(person,i.project_id,i.thread_id!,body);return {...base,id:i.thread_id!,thread_id:i.thread_id!,wip_limit_exceeded:work.wip_limit_exceeded};}
    case 'inquiry.lifecycle.transition':result=await iterations.transitionLifecycle(person,i.project_id,i.thread_id!,body);break;
    case 'inquiry.problem.record_work':await problem.recordWork(person,i.project_id,i.thread_id!,payload);return {...base,id:i.thread_id!,thread_id:i.thread_id!};
    case 'inquiry.problem.close_round':{const closed=await problem.closeRound(person,i.project_id,i.thread_id!,payload);return {...base,id:closed.id,thread_id:i.thread_id!,round_number:closed.round_number,iteration_id:closed.iteration_id};}
    case 'inquiry.task.link':return {...base,...await tasks.link(person,i.project_id,i.thread_id!,{...payload,...(i.task_id?{task_id:i.task_id}:{})})};
    case 'inquiry.task.reference_result':await tasks.referenceResult(person,i.project_id,i.thread_id!,i.task_id!,payload);return {...base,id:i.task_id!,thread_id:i.thread_id!};
    case 'inquiry.signal.create':result=await signals.createSignal(person,i.project_id,i.thread_id!,body);break;
    case 'inquiry.candidate.decide':result=await signals.decideCandidate(person,i.project_id,i.candidate_id!,body);break;
    case 'inquiry.candidate.reopen':result=await signals.reopenCandidate(person,i.project_id,i.candidate_id!);break;
    case 'inquiry.review_packet.open':result=await signals.openReviewPacket(person,i.project_id,body.limit as number);break;
    case 'inquiry.review_packet.close':result=await signals.closeReviewPacket(person,i.project_id,i.packet_id!);break;
    case 'inquiry.delta_brief.generate':result=await signals.generateDeltaBrief(person,i.project_id,body);break;
    default:throw new Error('Unregistered Inquiry workspace command');
   }
   return {...base,id:result?.id??null,...(i.thread_id?{thread_id:i.thread_id}:{})};
  },
  classifyError(error){if(error instanceof InquiryMutationError)return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode===409?409:422,'inquiry');if(error instanceof InquiryNoteUnavailable)return new OperationBusinessError('operation_invalid_input',422,'inquiry');return undefined;},
 }));
}
