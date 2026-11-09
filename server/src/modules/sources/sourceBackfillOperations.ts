import {lockSourceChannelReference} from './sourceMonitorParent.js';
import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {hidden,OperationBusinessError} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {assertSourceConnectionManageable,assertSourceConnectionReadable} from './sourceConnectionAccess.js';
import {SourceBackfillPlanningService} from './sourceBackfillService.js';
import {SourceBackfillMutationError} from './sourceBackfillErrors.js';

export const SOURCE_BACKFILL_OPERATIONS=['source.backfill.preview','source.backfill.create_plan','source.backfill.pause','source.backfill.resume'] as const;
type Id=typeof SOURCE_BACKFILL_OPERATIONS[number];
type Input=OperationInput<Id>;
interface Refs {project_source_binding_id?:string|null;project_operation_id?:string|null}
const identity=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function connection(db:Queryable,space:string,channel:string,lock=false){
  if(lock&&!await lockSourceChannelReference(db,space,channel))throw hidden();
  const row=(await db.query<{source_connection_id:string}>(`SELECT ch.source_connection_id FROM source_channels ch
    JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id
    WHERE ch.id=$1 AND ch.space_id=$2 AND ch.status<>'archived' AND sc.deleted_at IS NULL
`,[channel,space])).rows[0];
  if(!row)throw hidden();return row.source_connection_id;
}
async function plan(db:Queryable,space:string,channel:string,id:string,lock=false){
  const row=(await db.query<Refs&{id:string;status:string;source_channel_id:string}>(`SELECT id,status,source_channel_id,project_source_binding_id,project_operation_id
    FROM source_backfill_plans WHERE id=$1 AND space_id=$2 AND source_channel_id=$3 ${lock?'FOR UPDATE':''}`,[id,space,channel])).rows[0];
  if(!row)throw hidden();return row;
}
/** Reference authority joins Project -> binding/operation -> channel -> plan locks. */
async function projectRefs(db:Queryable,person:SpaceUserIdentity,channel:string,refs:Refs){
  const binding=refs.project_source_binding_id?(await db.query<{project_id:string}>('SELECT project_id FROM project_source_bindings WHERE id=$1 AND space_id=$2 AND source_channel_id=$3',[refs.project_source_binding_id,person.spaceId,channel])).rows[0]:null;
  const operation=refs.project_operation_id?(await db.query<{project_id:string}>('SELECT project_id FROM project_operations WHERE id=$1 AND space_id=$2',[refs.project_operation_id,person.spaceId])).rows[0]:null;
  if(refs.project_source_binding_id&&!binding||refs.project_operation_id&&!operation)throw hidden();
  if(binding&&operation&&binding.project_id!==operation.project_id)throw new OperationBusinessError('operation_invalid_input',422,'source_backfill');
  for(const id of [...new Set([binding?.project_id,operation?.project_id].filter((id):id is string=>!!id))].sort()){
    await assertProjectWriter(db,person.spaceId,id,person.userId,{allowArchived:true});
    try{await lockActiveProjectForMutation(db,person.spaceId,id);}catch(error){if(error instanceof HttpError&&error.statusCode===409)throw new OperationBusinessError('operation_conflict',409,'source_backfill');throw error;}
    await assertProjectWriterForMutation(db,person.spaceId,id,person.userId);
  }
  if(binding&&!(await db.query('SELECT id FROM project_source_bindings WHERE id=$1 AND space_id=$2 AND source_channel_id=$3 AND project_id=$4 FOR SHARE',[refs.project_source_binding_id,person.spaceId,channel,binding.project_id])).rows.length)throw hidden();
  if(operation&&!(await db.query('SELECT id FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[refs.project_operation_id,person.spaceId,operation.project_id])).rows.length)throw hidden();
}
async function authorize(db:Queryable,input:Input,actor:OperationActor,read=false){
  const person=identity(actor),channel=input.source_channel_id,conn=await connection(db,person.spaceId,channel);
  if(read){await assertSourceConnectionReadable(db,person,conn);return;}
  await assertSourceConnectionManageable(db,person,conn);
  const target='source_backfill_plan_id' in input?await plan(db,person.spaceId,channel,input.source_backfill_plan_id):null;
  const refs:Refs=target??('idempotency_key' in input?input:{});
  await projectRefs(db,person,channel,refs);
  const locked=await connection(db,person.spaceId,channel,true);
  if(locked!==conn)throw hidden();
  await assertSourceConnectionManageable(db,person,locked);
  if(target){
    const current=await plan(db,person.spaceId,channel,target.id,true);
    if(current.project_source_binding_id!==target.project_source_binding_id||current.project_operation_id!==target.project_operation_id)throw new OperationBusinessError('operation_conflict',409,'source_backfill');
  }
}
export function sourceBackfillRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return SOURCE_BACKFILL_OPERATIONS.map(id=>({
    definition:definitions.get(id)!,successStatus:id==='source.backfill.create_plan'?201:200,
    ...(id==='source.backfill.preview'?{readKind:'metadata' as const}:{}),
    async resolve(db,raw,actor){const input=raw as Input;await connection(db,actor.space_id,input.source_channel_id);return {authority:'source_backfill_plan_id' in input?`source_backfill_plan:${input.source_backfill_plan_id}`:`source_channel:${input.source_channel_id}`,targets:{source_channel_id:input.source_channel_id,...('source_backfill_plan_id' in input?{source_backfill_plan_id:input.source_backfill_plan_id}:{})},resourceType:'source_backfill_plan',resourceId:'source_backfill_plan_id' in input?input.source_backfill_plan_id:input.source_channel_id};},
    authorize:(db,raw,actor)=>authorize(db,raw as Input,actor,id==='source.backfill.preview'),
    ...(id==='source.backfill.preview'?{}:{async authorizeResult(db:Queryable,raw:unknown,actor:OperationActor){const out=raw as {plan_id:string;source_channel_id:string};await authorize(db,{source_channel_id:out.source_channel_id,source_backfill_plan_id:out.plan_id},actor);}}),
    async execute(db,raw,actor){
      const input=raw as Input,person=identity(actor),service=new SourceBackfillPlanningService(db);
      if(id==='source.backfill.preview')return service.preview(person,input.source_channel_id,input);
      const out=id==='source.backfill.create_plan'
        ?await service.create(person,input.source_channel_id,input)
        :await service.setPaused(person,input.source_channel_id,(input as OperationInput<'source.backfill.pause'>).source_backfill_plan_id,id==='source.backfill.pause');
      if(id==='source.backfill.create_plan'){
        const created=input as OperationInput<'source.backfill.create_plan'>;
        // The domain key can return an existing plan, but never change the
        // scope authorized by this command or acquire late Project locks.
        if((out.project_source_binding_id??null)!==(created.project_source_binding_id??null)||(out.project_operation_id??null)!==(created.project_operation_id??null))throw new SourceBackfillMutationError(409,'Domain key belongs to another plan scope');
      }
      return {plan_id:out.id,source_channel_id:out.source_channel_id,status:out.status};
    },
    classifyError(error){if(error instanceof SourceBackfillMutationError&&(error.statusCode===409||error.statusCode===422))return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode,'source_backfill');return undefined;},
  }));
}
