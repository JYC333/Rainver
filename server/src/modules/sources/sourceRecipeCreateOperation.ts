import {lockMonitorCreation} from './sourceMonitorParent.js';
import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {applyContentCreationContext,resolveContentCreationContext} from '../access/creationContext.js';
import {assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import type {Queryable} from '../routeUtils/common.js';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,OperationError,OperationBusinessError} from '../systemActions/operations/errors.js';
import {SourceRecipeCreateService,SourceRecipeCreateError} from './sourceRecipes/recipeCreateService.js';
import {SourceChannelCreateConflict,SourceChannelMutationError} from './channels/sourceChannelService.js';
import {assertSourceConnectionReadable} from './sourceConnectionAccess.js';
type Input=OperationInput<'source.recipe.create'>;
const person=(actor:OperationActor)=>({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!});
async function creation(db:Queryable,input:Input,actor:OperationActor){
  const identity=person(actor);
  const context=await resolveContentCreationContext(db,{userId:identity.userId,requestSpaceId:identity.spaceId,projectId:input.project_id});
  if(context.spaceId!==actor.space_id)throw new OperationError('operation_conflict',409);
  return context;
}
export function sourceRecipeCreateRegistration(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
  return {
    definition:definitions.get('source.recipe.create')!,userContentCreation:true,successStatus:201,
    async resolve(_db,raw){const input=raw as Input;return {authority:input.project_id?`project:${input.project_id}`:'personal_content',targets:{project_id:input.project_id??null},resourceType:'source_connection',resourceId:input.project_id??'new'};},
    async authorize(db,raw,actor){
      const input=raw as Input;await lockMonitorCreation(db,person(actor),true);const context=await creation(db,input,actor);
      if(context.projectId){await lockActiveProjectForMutation(db,actor.space_id,context.projectId);await assertProjectWriterForMutation(db,actor.space_id,context.projectId,person(actor).userId);}
      try{await new SourceRecipeCreateService(db,config).authorizeCreation(person(actor),input);}catch(error){if(error instanceof SourceRecipeCreateError&&error.statusCode===422)throw new OperationError('operation_invalid_input',422);throw error;}
    },
    async authorizeResult(db,raw,actor){const out=raw as {connection:{id:string;space_id:string}};
      if(out.connection.space_id!==actor.space_id)throw hidden();
      await assertSourceConnectionReadable(db,person(actor),out.connection.id);
    },
    async execute(db,raw,actor){const input=raw as Input;return new SourceRecipeCreateService(db,config).createSource(person(actor),applyContentCreationContext(input,await creation(db,input,actor)));},
    classifyError(error){if(error instanceof SourceChannelCreateConflict)return new OperationBusinessError('operation_conflict',409,'sources');if((error instanceof SourceRecipeCreateError||error instanceof SourceChannelMutationError)&&error.statusCode===422)return new OperationBusinessError('operation_invalid_input',422,'sources');return undefined;},
  };
}
