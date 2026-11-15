import type {OperationInput, RegisteredSystemActionDefinition} from '@rainver/protocol';
import {hidden, markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {HttpError} from '../routeUtils/common.js';
import {GraphViewStateRepository} from './viewStateRepository.js';

/** State is a private navigation blob, not a reference granting Project access. */
export function graphViewStateRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration {
  return {
    definition:definitions.get('graph.view_state.save')!,
    async resolve(_db,raw,actor) {
      const input=raw as OperationInput<'graph.view_state.save'>;
      return {authority:`graph-view:${actor.space_id}:${actor.on_behalf_of_user_id}`,targets:{scope_key:input.scope_key},resourceType:'space',resourceId:actor.space_id};
    },
    async authorize(_db,_raw,actor) {if(actor.principal.kind!=='user')throw hidden();},
    async authorizeResult(_db,raw,actor) {
      const out=raw as {space_id:string;user_id:string};
      if(actor.principal.kind!=='user'||out.space_id!==actor.space_id||out.user_id!==actor.on_behalf_of_user_id)throw hidden();
    },
    classifyError(error) {return error instanceof HttpError?markedRefusal(error,'graph'):undefined;},
    async execute(db,raw,actor) {
      const input=raw as OperationInput<'graph.view_state.save'>;
      return {space_id:actor.space_id,user_id:actor.on_behalf_of_user_id!,...await new GraphViewStateRepository(db).upsert({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!},input.scope_key,input.state_json??{})};
    },
  };
}
