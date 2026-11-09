import {discoverMonitorParent,type MonitorParent,SourceMonitorScopeConflict} from './sourceMonitorParent.js';
import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {SourceChannelService,SourceChannelMutationError} from './channels/sourceChannelService.js';
import {SourceGoalSchedulingConflict} from './goals/compatibility.js';
import {hidden,OperationBusinessError} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
const ids=['source.channel.update','source.channel.scan'] as const;
type Input=OperationInput<typeof ids[number]>;
const person=(actor:OperationActor)=>({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!});
export function sourceMonitorRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return ids.map(id=>({
    definition:definitions.get(id)!,successStatus:id==='source.channel.scan'?202:200,
    async resolve(db,raw,actor){const input=raw as Input;const channel=await new SourceChannelService(db,config).discoverCreator(person(actor),input.source_channel_id);const parent=await discoverMonitorParent(db,person(actor),channel.source_connection_id);return {parent,authority:`source_channel:${input.source_channel_id}`,targets:{source_channel_id:input.source_channel_id},resourceType:'source_channel',resourceId:input.source_channel_id};},
    async authorize(db,raw,actor,scope){await new SourceChannelService(db,config).requireCreator(person(actor),(raw as Input).source_channel_id,(scope as typeof scope&{parent:MonitorParent}).parent);},
    async authorizeResult(db,raw,actor){
      const output=raw as {id:string;space_id:string;connection_id?:string;metadata_json?:{source_channel_id:string}};
      if(output.space_id!==actor.space_id)throw hidden();
      const channel=output.metadata_json?.source_channel_id??output.id,service=new SourceChannelService(db,config);
      await service.requireCreator(person(actor),channel);
      if(id==='source.channel.scan'){
        const job=(await db.query<{connection_id:string;source_channel_id:string}>("SELECT connection_id,metadata_json->>'source_channel_id' AS source_channel_id FROM extraction_jobs WHERE id=$1 AND space_id=$2 AND job_type='connection_scan'",[output.id,actor.space_id])).rows[0];
        if(!job||job.source_channel_id!==channel||job.connection_id!==output.connection_id)throw hidden();
      }
    },
    async execute(db,raw,actor){const input=raw as Input,service=new SourceChannelService(db,config);return 'changes' in input?service.update(person(actor),input.source_channel_id,input.changes):service.scan(person(actor),input.source_channel_id);},
    classifyError(error){
      if(error instanceof SourceMonitorScopeConflict||error instanceof SourceGoalSchedulingConflict||error instanceof SourceChannelMutationError)return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode===409?409:422,'sources');
      const pg=error as {code?:string;constraint?:string};if(pg?.code==='23505'&&['uq_source_connections_active_owner_mapping_personal','uq_source_connections_active_owner_mapping_project'].includes(pg.constraint??''))return new OperationBusinessError('operation_conflict',409,'sources');
      return undefined;
    },
  }));
}
