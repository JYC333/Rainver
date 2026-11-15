import {assertCompositionRetryReadable} from './mutationAccess.js';
import type {OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {HttpError} from '../../routeUtils/common.js';
import {assertProjectWriterForMutation} from '../../projects/access.js';
import {hidden,markedRefusal} from '../../systemActions/operations/errors.js';
import type {OperationRegistration} from '../../systemActions/operations/types.js';
import {retryProjectComposition} from './service.js';
type Input=OperationInput<'reading.composition.retry'>;
export function compositionRetryRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:defs.get('reading.composition.retry')!,
  async resolve(_db,raw,a){const i=raw as Input;return {authority:`space:${a.space_id}`,targets:{...i,user_id:a.on_behalf_of_user_id},resourceType:'project',resourceId:i.project_id};},
  async authorize(db,raw,a){const i=raw as Input;if(i.space_id!==a.space_id)throw hidden();await assertProjectWriterForMutation(db,a.space_id,i.project_id,a.on_behalf_of_user_id!);},
  async authorizeResult(db,raw,a){const i=raw as Input&{user_id:string;round_ids:string[]};if(i.space_id!==a.space_id||i.user_id!==a.on_behalf_of_user_id)throw hidden();await assertProjectWriterForMutation(db,a.space_id,i.project_id,a.on_behalf_of_user_id!);await assertCompositionRetryReadable(db,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},i.project_id,i.round_ids);},
  async execute(db,raw,a){const i=raw as Input;return {...i,user_id:a.on_behalf_of_user_id!,...await retryProjectComposition(db,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},i.project_id)};},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'reading'):undefined,
 };
}
