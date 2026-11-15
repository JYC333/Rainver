import {discoverNoteCreationParent} from '../../knowledge/noteObjectAdmission.js';
import {discoverMonitorParent} from '../../sources/sourceMonitorParent.js';
import type {OperationActor} from '@rainver/protocol';
import {resolveContentCreationContext} from '../../access/creationContext.js';
import {HttpError,type Queryable} from '../../routeUtils/common.js';
import {hidden,OperationError} from './errors.js';
/** Placement of new human content, never an arbitrary actor/Space resolver. */
export async function resolveUserCreationActor(db:Queryable,input:unknown,actor:OperationActor,operationId?:string):Promise<OperationActor>{
  if(actor.principal.kind!=='user'||actor.principal.id!==actor.on_behalf_of_user_id||actor.agent_id||actor.run_id||actor.root_run_id||actor.continuation_hops!==0||actor.origin!=='manual'||actor.effective_origin!=='manual'||!['web','public_api'].includes(actor.surface))throw hidden();
  const body={...(input as {project_id?:string|null;source_connection_id?:string|null})};
  if(operationId==='capture.create'&&(input as {destination:string}).destination==='personal_inbox')body.project_id=null;
  if(operationId==='knowledge.note.create'){
    const note=input as {collection_id?:string|null;primary_project_id?:string|null};
    if(note.collection_id){const project=await discoverNoteCreationParent(db,{spaceId:actor.space_id,userId:actor.principal.id},note.collection_id);if(note.primary_project_id&&project!==note.primary_project_id)throw new OperationError('operation_conflict',409);return actor;}
    body.project_id=note.primary_project_id;
  }
  if(operationId==='source.channel.create'&&body.source_connection_id){
    const parent=await discoverMonitorParent(db,{spaceId:actor.space_id,userId:actor.principal.id},body.source_connection_id);
    if(parent.owner_user_id!==actor.principal.id)throw hidden();
    if(body.project_id&&body.project_id!==parent.project_id)throw new OperationError('operation_conflict',409);
    return actor; // A child inherits its authorized parent in the request Space.
  }
  // A named connection or source decides placement in the request Space, as the retained REST adapters always did.
  const sourced=input as {connection_id?:string|null;source_item_id?:string|null;artifact_id?:string|null};
  if(operationId==='source.item.save_url'&&sourced.connection_id)return actor;
  if(operationId==='source.evidence.create'&&(sourced.source_item_id||sourced.artifact_id))return actor;
  try{
    const context=await resolveContentCreationContext(db,{userId:actor.principal.id,requestSpaceId:actor.space_id,projectId:body.project_id});
    // The access owner chooses only placement. Principal, origin and Run
    // authority remain the verified caller's and cannot come from domain input.
    return {...actor,space_id:context.spaceId};
  }catch(error){
    if(error instanceof HttpError&&(error.statusCode===409||error.statusCode===422))throw new OperationError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode);
    throw error;
  }
}
