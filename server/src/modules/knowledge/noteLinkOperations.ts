import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {NOTE_LINK_SCHEMAS} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {OperationError,OperationRefusal,hidden} from '../systemActions/operations/errors.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {PgKnowledgeRepository} from './repository.js';
import {NoteMutationConflict} from './noteControlErrors.js';
import {NoteLinkRefusal} from './noteLinkErrors.js';

type Id=keyof typeof NOTE_LINK_SCHEMAS;
const person=(actor:OperationActor)=>({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!});
type Bound={note:string|null;notePrimaryProject:string|null;project:string|null;target:string|null};
type Scope=ResolvedOperation&{bound:Bound};

async function discover(db:Queryable,raw:Record<string,unknown>,actor:OperationActor):Promise<Bound>{
  const note=typeof raw.note_id==='string'?raw.note_id:null;
  const row=note?(await db.query<{primary_project_id:string|null}>("SELECT primary_project_id FROM space_objects WHERE id=$1 AND space_id=$2 AND object_type='note' AND deleted_at IS NULL",[note,actor.space_id])).rows[0]:null;
  if(note&&!row)throw hidden();
  const target=typeof raw.target_id==='string'?raw.target_id:null;
  if(target)await new PgKnowledgeRepository(db).requireVisibleObject(person(actor),target);
  return {note,notePrimaryProject:row?.primary_project_id??null,project:typeof raw.project_id==='string'?raw.project_id:null,target};
}
/** Note controls own their Project-before-root lock order and recheck; a drift is a conflict. */
async function noteControl(db:Queryable,actor:OperationActor,noteId:string,incomingSource:string|null){
  try{
    const repo=new PgKnowledgeRepository(db);
    // An incoming link is written on the caller-supplied source: both endpoints are controlled, in one order.
    if(incomingSource)await repo.authorizeNoteLinkControl(person(actor),noteId,incomingSource);
    else await repo.authorizeNoteControl(person(actor),noteId);
  }
  catch(error){if(error instanceof NoteMutationConflict)throw new OperationError('operation_conflict',409);throw error;}
}

export function noteLinkRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return (Object.keys(NOTE_LINK_SCHEMAS) as Id[]).map(id=>({
    definition:definitions.get(id)!,
    successStatus:id==='knowledge.note.link.delete'?200:201,
    async resolve(db,raw,actor){
      const bound=await discover(db,raw as Record<string,unknown>,actor);
      const authority=bound.note?`note:${bound.note}`:bound.target?`note_jot:${bound.project??'unbound'}:${bound.target}`:`note_inbox:${bound.project}`;
      return {authority,targets:bound,resourceType:'note',resourceId:bound.note,bound} as Scope;
    },
    async authorize(db,raw,actor,scope){
      const bound=(scope as Scope).bound;
      if(bound.note){
        // An explicit Note decides the Project; a different Project name is a conflict, not a second scope.
        if(bound.project&&bound.project!==bound.notePrimaryProject)throw new OperationError('operation_conflict',409);
        const input=raw as {direction?:string;target_id?:string};
        await noteControl(db,actor,bound.note,id==='knowledge.note.link.create'&&input.direction==='incoming'&&typeof input.target_id==='string'?input.target_id:null);
      }else if(bound.project)await assertProjectWriterForMutation(db,actor.space_id,bound.project,person(actor).userId);
      const current=await discover(db,raw as Record<string,unknown>,actor);
      if(current.notePrimaryProject!==bound.notePrimaryProject)throw new OperationError('operation_conflict',409);
    },
    async execute(db,raw,actor){
      const repo=new PgKnowledgeRepository(db),p=person(actor);
      if(id==='knowledge.note.link.create'){
        const {note_id,...body}=raw as OperationInput<'knowledge.note.link.create'>;
        const link=await repo.createNoteLink(p,note_id,body);
        return {id:String(link.id),space_id:actor.space_id,note_id};
      }
      if(id==='knowledge.note.link.delete'){
        const input=raw as OperationInput<'knowledge.note.link.delete'>;
        await repo.deleteNoteLink(p,input.note_id,input.link_id);
        return {id:input.link_id,space_id:actor.space_id,note_id:input.note_id};
      }
      const input=raw as OperationInput<'knowledge.note.jot'>;
      const note=await repo.jotNoteForObject(p,{text:input.text,target_id:input.target_id??undefined,note_id:input.note_id??undefined,project_id:input.project_id??undefined,collection_id:input.collection_id??undefined,link_type:input.link_type});
      return {id:String(note.id),space_id:actor.space_id};
    },
    /** A jot may append to a Note found by its target: the written Note must be one the caller may write now. */
    async authorizeResult(db,raw,actor){
      const out=raw as {id:string;space_id:string;note_id?:string};
      if(out.space_id!==actor.space_id)throw hidden();
      await new PgKnowledgeRepository(db).requireNoteWriteReach(person(actor),out.note_id??out.id);
    },
    classifyError(error){
      if(error instanceof NoteLinkRefusal)return new OperationRefusal(error.statusCode as 409|422,'knowledge',error.message,error.responseBody);
      const pg=error as {code?:string;constraint?:string};
      if(pg?.code==='23505'&&pg.constraint==='ix_note_links_unique_active')return new OperationRefusal(409,'knowledge','This link already exists');
      return undefined;
    },
  }));
}
