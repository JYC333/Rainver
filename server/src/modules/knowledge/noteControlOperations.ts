import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {PgKnowledgeRepository} from './repository.js';
import type {Queryable} from '../routeUtils/common.js';
import {NoteMutationConflict} from './noteControlErrors.js';
const ids=['knowledge.note.rollback','knowledge.note.delete'] as const;
type Input=OperationInput<typeof ids[number]>;
const identity=(actor:OperationActor)=>({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!});
async function authorize(db:Queryable,actor:OperationActor,id:string){
  try{await new PgKnowledgeRepository(db).authorizeNoteControl(identity(actor),id);}
  catch(error){if(error instanceof NoteMutationConflict)throw new OperationError('operation_conflict',409);throw error;}
}
export function noteControlRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return ids.map(id=>({
    definition:definitions.get(id)!,
    async resolve(_db,raw){const input=raw as Input;return {authority:`note:${input.note_id}`,targets:{note_id:input.note_id},resourceType:'note',resourceId:input.note_id};},
    authorize:(db,raw,actor)=>authorize(db,actor,(raw as Input).note_id),
    async authorizeResult(db,raw,actor){const output=raw as {id:string;space_id:string};if(output.space_id!==actor.space_id)throw hidden();await authorize(db,actor,output.id);},
    async execute(db,raw,actor){const input=raw as Input,repo=new PgKnowledgeRepository(db),person=identity(actor);
      const result='to_version' in input?await repo.rollbackNote(person,input.note_id,input.to_version,input.expect_version):await repo.deleteNote(person,input.note_id);
      return {id:result.id,space_id:result.space_id,version:result.version};
    },
    classifyError(error){return error instanceof NoteMutationConflict?new OperationBusinessError('operation_conflict',409,'knowledge'):undefined;},
  }));
}
