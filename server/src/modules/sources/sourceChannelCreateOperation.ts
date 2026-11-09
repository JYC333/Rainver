import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {applyContentCreationContext,resolveContentCreationContext} from '../access/creationContext.js';
import {assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import type {Queryable} from '../routeUtils/common.js';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,OperationError,OperationBusinessError} from '../systemActions/operations/errors.js';
import {SourceGovernanceInputError} from './sourceConsent.js';
import {ResearchQueryInputError} from '../research/queryPlanning/providerCompiler.js';
import {discoverMonitorParent,lockMonitorParent,lockMonitorCreation,SourceMonitorScopeConflict,type MonitorParent} from './sourceMonitorParent.js';
import {SourceChannelService,SourceChannelCreateConflict,SourceChannelMutationError} from './channels/sourceChannelService.js';
type Input=OperationInput<'source.channel.create'>;
const person=(actor:OperationActor)=>({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!});
async function creation(db:Queryable,input:Input,actor:OperationActor){
  const identity=person(actor);
  const context=await resolveContentCreationContext(db,{userId:identity.userId,requestSpaceId:identity.spaceId,projectId:input.project_id});
  if(context.spaceId!==actor.space_id)throw new OperationError('operation_conflict',409);
  return context;
}
export function sourceChannelCreateRegistration(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
  return {
    definition:definitions.get('source.channel.create')!,userContentCreation:true,successStatus:201,
    async resolve(db,raw,actor){const input=raw as Input;const parent=input.source_connection_id?await discoverMonitorParent(db,person(actor),input.source_connection_id):undefined;return {authority:parent?`source_connection:${parent.id}`:input.project_id?`project:${input.project_id}`:'personal_content',targets:parent?{source_connection_id:parent.id}:{project_id:input.project_id??null},resourceType:'source_channel',resourceId:null,parent};},
    async authorize(db,raw,actor,scope){
      const input=raw as Input;await lockMonitorCreation(db,person(actor),true);
      const parent=(scope as typeof scope&{parent?:MonitorParent}).parent;
      if(parent){if(parent.owner_user_id!==actor.principal.id)throw hidden();if(input.project_id&&input.project_id!==parent.project_id)throw new SourceMonitorScopeConflict();await lockMonitorParent(db,person(actor),parent);}
      else{const context=await creation(db,input,actor);if(context.projectId){await lockActiveProjectForMutation(db,actor.space_id,context.projectId);await assertProjectWriterForMutation(db,actor.space_id,context.projectId,person(actor).userId);}}
    },
    async authorizeResult(db,raw,actor){const out=raw as {id:string;space_id:string;project_id:string|null};
      if(out.space_id!==actor.space_id)throw hidden();
      const current=await new SourceChannelService(db,config).requireCreator(person(actor),out.id);
      if(out.project_id!==current.project_id)throw new SourceMonitorScopeConflict();
    },
    async execute(db,raw,actor){const input=raw as Input;if(input.source_connection_id)return new SourceChannelService(db,config).create(person(actor),input);return new SourceChannelService(db,config).create(person(actor),applyContentCreationContext(input,await creation(db,input,actor)));},
    classifyError(error){if(error instanceof SourceChannelCreateConflict||error instanceof SourceMonitorScopeConflict)return new OperationBusinessError('operation_conflict',409,'sources');if((error instanceof ResearchQueryInputError||error instanceof SourceGovernanceInputError||error instanceof SourceChannelMutationError)&&error.statusCode===422)return new OperationBusinessError('operation_invalid_input',422,'sources');return undefined;},
  };
}
