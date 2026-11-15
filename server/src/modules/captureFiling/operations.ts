import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {HttpError} from '../routeUtils/common.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {admitFiling} from './admission.js';
import {CaptureFilingService} from './service.js';
const target=(i:OperationInput<'capture.file'>,a:OperationActor)=>({userId:a.on_behalf_of_user_id!,activityId:i.activity_id,targetProjectId:i.target_project_id});
export function captureFilingRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:definitions.get('capture.file')!,admission:{kind:'person'},domainAuthorizationFirst:true,
  async resolve(_db,raw,a){const i=raw as OperationInput<'capture.file'>;return {authority:`person-filing:${a.principal.id}:${i.activity_id}`,targets:i,resourceType:'activity',resourceId:i.activity_id};},
  async authorize(db,raw,a){await admitFiling(db,target(raw as OperationInput<'capture.file'>,a));},
  async authorizeResult(db,raw,a){
   const out=raw as {activity_id:string;object_id:string;target_space_id:string;target_project_id:string};
   await admitFiling(db,{userId:a.on_behalf_of_user_id!,activityId:out.activity_id,targetProjectId:out.target_project_id});
   if(await contentDecisionFromDb(db,{spaceId:out.target_space_id,userId:a.on_behalf_of_user_id!},'space_object',out.object_id,{includeOversight:false})!=='full')throw hidden();
  },
  async execute(db,raw,a){const i=raw as OperationInput<'capture.file'>;return new CaptureFilingService(db).file({...target(i,a),title:i.title});},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'captureFiling'):undefined,
 };
}
