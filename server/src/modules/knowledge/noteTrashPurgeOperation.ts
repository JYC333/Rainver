import type {RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {canWriteProject} from '../projects/access.js';
import {PgKnowledgeRepository} from './repository.js';

/**
 * Permanent deletion of the caller's purgeable trash as a core command. The
 * existing writer keeps its rule unchanged: only Notes past the retention
 * window, one bounded batch, each judged by the Note write rule again under
 * the batch's Project writer locks and Note row locks. The explicit key makes
 * a retry replay its receipt instead of deleting another batch; the receipt
 * carries the batch's Project scope and is released only while the caller
 * still writes each of those Projects. The UI's confirmation stays the caller's.
 */
export function noteTrashPurgeRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
  return {
    definition:definitions.get('knowledge.note.trash.purge')!,
    async resolve(_db,_raw,a){return {authority:`note_trash:${a.space_id}:${a.on_behalf_of_user_id}`,targets:{},resourceType:'note',resourceId:null};},
    async authorize(){},
    async authorizeResult(db,raw,a){
      const out=raw as {space_id:string;project_ids?:string[]};
      if(out.space_id!==a.space_id)throw hidden();
      for(const project of out.project_ids??[])if(!await canWriteProject(db,a.space_id,project,a.on_behalf_of_user_id!))throw hidden();
    },
    async execute(db,_raw,a){
      const out=await new PgKnowledgeRepository(db).purgeDeletedNotes({spaceId:a.space_id,userId:a.on_behalf_of_user_id!}) as {deleted:number;retention_days:number;project_ids:string[]};
      return {id:a.space_id,space_id:a.space_id,deleted:out.deleted,retention_days:out.retention_days,project_ids:out.project_ids};
    },
  };
}
