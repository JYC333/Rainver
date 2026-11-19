import {AUTHORIZATION_REQUEST_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {markedRefusal} from '../systemActions/operations/errors.js';
import {AuthorizationRequestService} from './authorizationRequestService.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
export function authorizationRequestRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return (Object.keys(AUTHORIZATION_REQUEST_OPERATION_SCHEMAS) as (keyof typeof AUTHORIZATION_REQUEST_OPERATION_SCHEMAS)[]).map(id=>{
  const decision=id==='policy.authorization_request.approve'?'approved':'rejected';
  const service=(db:Queryable)=>new AuthorizationRequestService(db,config);
  return {
   definition:defs.get(id)!,
   async resolve(_db,raw,a){const i=raw as {request_id:string};return {authority:`space:${a.space_id}`,targets:i,resourceType:'authorization_request',resourceId:i.request_id};},
   async authorize(db,raw,a){await service(db).authorizeDecision(db,person(a),(raw as {request_id:string}).request_id,decision);},
   async authorizeResult(db,raw,a){await service(db).authorizeDecision(db,person(a),(raw as {request_id:string}).request_id,decision);},
   async execute(db,raw,a){const row=await service(db).decideInTransaction(db,person(a),(raw as {request_id:string}).request_id,decision);
    return {request_id:row.id,space_id:row.space_id,run_id:row.run_id,status:row.status,resulting_action_grant_id:row.resulting_action_grant_id,resulting_plugin_data_grant_id:row.resulting_plugin_data_grant_id};
   },
   classifyError(e){return e instanceof HttpError?markedRefusal(e,'policy'):undefined;},
  };
 });
}
