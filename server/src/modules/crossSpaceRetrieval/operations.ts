import {CROSS_SPACE_RETRIEVAL_OPERATION_SCHEMAS,type OperationInput,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden, markedRefusal} from '../systemActions/operations/errors.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {SpaceCommandError} from '../spaces/writers.js';
import {CrossSpaceRetrievalService,lockEgressNotificationManager, updateEgressNotificationSetting} from './service.js';

export function egressNotificationRegistration(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration {
  return {
    definition: definitions.get('space.egress_notifications.update')!,
    async resolve(_db, raw, actor) {
      const input = raw as OperationInput<'space.egress_notifications.update'>;
      if (input.space_id !== actor.space_id) throw hidden();
      return {authority: `space:${actor.space_id}`, targets: {space_id: actor.space_id}, resourceType: 'space', resourceId: actor.space_id};
    },
    async authorize(db, _raw, actor) {
      if (actor.principal.kind !== 'user') throw hidden();
      await lockEgressNotificationManager(db, actor.on_behalf_of_user_id!, actor.space_id);
    },
    async authorizeResult(db, raw, actor) {
      if ((raw as {space_id: string}).space_id !== actor.space_id) throw hidden();
      await lockEgressNotificationManager(db, actor.on_behalf_of_user_id!, actor.space_id);
    },
    classifyError(error) {
      return error instanceof HttpError || error instanceof SpaceCommandError ? markedRefusal(error, 'crossSpaceRetrieval') : undefined;
    },
    async execute(db, raw, actor) {
      const input = raw as OperationInput<'space.egress_notifications.update'>;
      return updateEgressNotificationSetting(db, actor.on_behalf_of_user_id!, actor.space_id, input.egress_notifications_enabled);
    },
  };
}

export function personalRetrievalRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 type Id=keyof typeof CROSS_SPACE_RETRIEVAL_OPERATION_SCHEMAS;
 type Input={query?:string;resource_types?:OperationInput<'personal.retrieval.search'>['resource_types'];max_results?:number;pointer_ids?:string[];summary?:string;disclosure_id?:string;conclusion?:string};
 const prepared=new WeakMap<Queryable,Awaited<ReturnType<CrossSpaceRetrievalService['prepareSearch']>>>();
 return (Object.keys(CROSS_SPACE_RETRIEVAL_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,admission:{kind:'person'},domainAuthorizationFirst:true,
  successStatus:id==='personal.retrieval.summary.store'||id==='personal.retrieval.fused.store'?201:200,
  async resolve(_db,raw,a){return {authority:`personal-retrieval:${a.principal.id}`,targets:raw,resourceType:'personal_retrieval',resourceId:null};},
  async authorize(db,raw,a){
   const owner=new CrossSpaceRetrievalService(db),input=raw as Input,userId=a.on_behalf_of_user_id!;
   if(id==='personal.retrieval.search')prepared.set(db,await owner.prepareSearch({userId,query:input.query!,resourceTypes:input.resource_types,maxResults:input.max_results}));
   else await owner.preparePointers(userId,input.pointer_ids!);
  },
  async authorizeResult(db,output,a){await new CrossSpaceRetrievalService(db).authorizeStoredResult(a.on_behalf_of_user_id!,output);},
  async execute(db,raw,a){
   const owner=new CrossSpaceRetrievalService(db,false),input=raw as Input,userId=a.on_behalf_of_user_id!;
   switch(id){
    case 'personal.retrieval.search':return owner.search({userId,query:input.query!,resourceTypes:input.resource_types,maxResults:input.max_results},prepared.get(db));
    case 'personal.retrieval.resolve':return owner.resolve(userId,input.pointer_ids!);
    case 'personal.retrieval.summary.store':return owner.storeSingleSourceSummary(userId,input.pointer_ids!,input.summary!);
    case 'personal.retrieval.egress.disclose':return owner.discloseEgress(userId,input.pointer_ids!);
    case 'personal.retrieval.fused.store':return owner.storeFusedConclusion({userId,disclosureId:input.disclosure_id!,pointerIds:input.pointer_ids!,conclusion:input.conclusion!});
   }
  },
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'crossSpaceRetrieval'):undefined,
 }));
}
