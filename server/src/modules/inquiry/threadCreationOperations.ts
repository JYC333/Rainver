import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,OperationBusinessError} from '../systemActions/operations/errors.js';
import {assertThreadReadable} from './threadAccess.js';
import {assertLinkableNote,InquiryCreationConflict,InquiryNoteUnavailable} from './threadCreationAccess.js';
import {InquiryThreadService} from './threadService.js';
type Id='note.raise_as_question'|'inquiry.thread.create';
type Input=OperationInput<Id>;
const identity=(actor:OperationActor)=>({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!});
async function authorize(db:Queryable,input:{project_id:string;note_object_id?:string;primary_parent_id?:string|null},actor:OperationActor){
  const person=identity(actor);
  await assertProjectWriter(db,person.spaceId,input.project_id,person.userId,{allowArchived:true});
  try{await lockActiveProjectForMutation(db,person.spaceId,input.project_id);}catch(error){
    if(error instanceof HttpError&&error.statusCode===409)throw new OperationBusinessError('operation_conflict',409,'inquiry');throw error;
  }
  await assertProjectWriterForMutation(db,person.spaceId,input.project_id,person.userId);
  if(input.note_object_id)await assertLinkableNote(db,person,input.note_object_id,{lock:true,statusCode:404});
  if(input.primary_parent_id)await assertThreadReadable(db,person,input.project_id,input.primary_parent_id,'change');
}
/** One human action composes the existing Thread/revision/event/reference writers. */
export function threadCreationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return (['note.raise_as_question','inquiry.thread.create'] as const).map(id=>({
    definition:definitions.get(id)!,successStatus:201,
    async resolve(_db,raw){const input=raw as Input;return {authority:`project:${input.project_id}`,targets:{project_id:input.project_id,...('note_object_id' in input?{note_object_id:input.note_object_id}:{})},resourceType:'project',resourceId:input.project_id};},
    authorize:(db,raw,actor)=>authorize(db,raw as Input,actor),
    async authorizeResult(db,raw,actor){const out=raw as {project_id:string;note_object_id?:string;thread_id:string};await authorize(db,out,actor);await assertThreadReadable(db,identity(actor),out.project_id,out.thread_id,'change');},
    async execute(db,raw,actor){
      const input=raw as Input;
      try{
        const service=new InquiryThreadService(db);
        const thread=id==='note.raise_as_question'?await service.raiseNoteAsQuestion(identity(actor),input.project_id,input):await service.createThread(identity(actor),input.project_id,input);
        return {thread_id:thread.id,project_id:input.project_id,...('note_object_id' in input?{note_object_id:input.note_object_id}:{}),kind:thread.kind};
      }catch(error){if(error instanceof InquiryNoteUnavailable)throw hidden();throw error;}
    },
    classifyError(error){if(error instanceof InquiryCreationConflict)return new OperationBusinessError('operation_conflict',409,'inquiry');return undefined;},
  }));
}
