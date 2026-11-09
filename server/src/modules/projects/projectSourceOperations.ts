import {lockSourceChannelReference} from '../sources/sourceMonitorParent.js';
import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from './access.js';
import {hidden,OperationBusinessError} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {ProjectSourceBindingRepository} from './projectSourceBindingRepository.js';
import {ProjectSourceBindingService} from './projectSourceBindingService.js';
import {ProjectSourceMutationError} from './projectSourceMutationError.js';
const ids=['project.source.bind','project.source.update','project.source.unbind','project.source.backfill'] as const;
type Id=typeof ids[number];type Input=OperationInput<Id>;
const identity=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function authorize(db:Queryable,id:Id,input:Input,actor:OperationActor){
  const person=identity(actor);
  await assertProjectWriter(db,person.spaceId,input.project_id,person.userId,{allowArchived:true});
  try{await lockActiveProjectForMutation(db,person.spaceId,input.project_id);}catch(error){if(error instanceof HttpError&&error.statusCode===409)throw new OperationBusinessError('operation_conflict',409,'projects');throw error;}
  await assertProjectWriterForMutation(db,person.spaceId,input.project_id,person.userId);
  let channel:string;
  if('source_channel_id' in input)channel=input.source_channel_id;
  else{
    const row=(await db.query<{source_channel_id:string}>(`SELECT source_channel_id FROM project_source_bindings WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE`,[input.binding_id,person.spaceId,input.project_id])).rows[0];
    if(!row)throw hidden();channel=row.source_channel_id;
  }
  if(id==='project.source.bind'||id==='project.source.update'){
    // Pin parent then child, independently of PostgreSQL JOIN rowmark order.
    if(!await lockSourceChannelReference(db,person.spaceId,channel))throw hidden();
    if(!(await db.query(`SELECT ch.id FROM source_channels ch JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id
      WHERE ch.id=$1 AND ch.space_id=$2 AND ch.status<>'archived' AND sc.deleted_at IS NULL`,[channel,person.spaceId])).rows[0])throw hidden();
    await new ProjectSourceBindingRepository(db).assertSourceBindingAuthority(person,channel,'changes' in input?input.changes:input,id==='project.source.bind');
  }
}
export function projectSourceRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return ids.map(id=>({
    definition:definitions.get(id)!,successStatus:id==='project.source.bind'?201:200,
    async resolve(_db,raw){const input=raw as Input;return {authority:`project:${input.project_id}`,targets:{project_id:input.project_id,...('binding_id' in input?{binding_id:input.binding_id}:{source_channel_id:input.source_channel_id})},resourceType:'project_source',resourceId:'binding_id' in input?input.binding_id:input.project_id};},
    authorize:(db,raw,actor)=>authorize(db,id,raw as Input,actor),
    async authorizeResult(db,raw,actor){const out=raw as {id?:string;binding_id?:string;project_id?:string};
      const binding=out.binding_id??out.id!;
      const target=(await db.query<{project_id:string}>('SELECT project_id FROM project_source_bindings WHERE id=$1 AND space_id=$2',[binding,actor.space_id])).rows[0];
      if(!target||out.project_id&&out.project_id!==target.project_id)throw hidden();
      // Binding configuration is Project-owned. The immutable input rechecks
      // requested Source sharing authority; the result rechecks current ownership.
      await authorize(db,'project.source.unbind',{project_id:target.project_id,binding_id:binding},actor);
    },
    async execute(db,raw,actor){const input=raw as Input,service=new ProjectSourceBindingService(db),person=identity(actor);
      if(id==='project.source.bind')return service.createBinding(person,input);
      const target=input as OperationInput<'project.source.unbind'>;
      if(id==='project.source.update')return service.updateBinding(person,target.binding_id,(input as OperationInput<'project.source.update'>).changes,input.project_id);
      return id==='project.source.unbind'?service.deleteBinding(person,target.binding_id,input.project_id):service.backfillBinding(person,target.binding_id,input.project_id);
    },
    classifyError(error){
      if(error instanceof ProjectSourceMutationError&&(error.statusCode===409||error.statusCode===422))return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode,'projects');
      const database=error as {code?:string;constraint?:string};
      if(database?.code==='23505'&&database.constraint==='uq_project_source_bindings_project_channel')return new OperationBusinessError('operation_conflict',409,'projects');
      return undefined;
    },
  }));
}
