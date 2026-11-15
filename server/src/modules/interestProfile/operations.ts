import {PgSourceAnnotationRepository} from '../sourceAnnotation/repository.js';
import type { ServerConfig } from '../../config.js';
import { InterestStarterPackService } from '../informationDigest/starterPacks.js';
import { SourceAnnotationService } from '../sourceAnnotation/service.js';
import { lockInterestSources, type InterestSourceRef } from './sourceAuthority.js';
import type { OperationActor, OperationInput, RegisteredSystemActionDefinition } from '@rainver/protocol';
import { INTEREST_OPERATION_SCHEMAS } from '@rainver/protocol';
import { HttpError, type Queryable } from '../routeUtils/common.js';
import { lockSpaceRole, SpaceCommandError } from '../spaces/writers.js';
import { hidden, markedRefusal } from '../systemActions/operations/errors.js';
import type { OperationRegistration } from '../systemActions/operations/types.js';
import { isKnownDomain } from '../sourceAnnotation/index.js';
import { topicKeyFor } from './topicKey.js';
import { InterestProfileService } from './service.js';
import type { InterestTopicRow } from './repository.js';

const topicView = ({id,topic_key,label,domain_key,aliases,weight,origin,status}:InterestTopicRow) => ({id,topic_key,label,domain_key,aliases,weight,origin,status});
async function owner(db:Queryable, actor:OperationActor, space:string) {
  if(space!==actor.space_id || actor.principal.kind!=='user') throw hidden();
  await lockSpaceRole(db,space,actor.on_behalf_of_user_id!);
  await db.query('SELECT id FROM spaces WHERE id=$1 FOR SHARE',[space]);
}
export function interestRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[] {
  const history=new WeakMap<Queryable,Awaited<ReturnType<PgSourceAnnotationRepository['prepareSubscriptionHistory']>>>();
  const starter=new WeakMap<Queryable,Awaited<ReturnType<InterestStarterPackService['prepare']>>>();
  return (Object.keys(INTEREST_OPERATION_SCHEMAS) as (keyof typeof INTEREST_OPERATION_SCHEMAS)[]).map(id=>({
    definition:definitions.get(id)!,
    ...(['interest.history.backfill','interest.starter_pack.apply'].includes(id)?{domainAuthorizationFirst:true as const}:{}),
    successStatus:id==='interest.topic.create'?201:200,
    async resolve(_db,raw,actor) {
      const input=raw as OperationInput<typeof id>;
      return {authority:`interest:${actor.space_id}:${actor.on_behalf_of_user_id}`,targets:{...input,user_id:actor.on_behalf_of_user_id},resourceType:'space',resourceId:input.space_id};
    },
    async authorize(db,raw,actor) {
      if((raw as {space_id:string}).space_id!==actor.space_id||actor.principal.kind!=='user')throw hidden();
      // These owners discover every Source/Project before the shared person
      // phase. Their closure validates current membership even for no inputs.
      if(id==='interest.history.backfill')history.set(db,await new PgSourceAnnotationRepository(db).prepareSubscriptionHistory(actor.space_id,actor.on_behalf_of_user_id!,(raw as OperationInput<'interest.history.backfill'>).limit??500));
      else if(id==='interest.starter_pack.apply')starter.set(db,await new InterestStarterPackService(db).prepare(actor.space_id,actor.on_behalf_of_user_id!,(raw as OperationInput<'interest.starter_pack.apply'>).key));
      else await owner(db,actor,actor.space_id);
    },
    async authorizeResult(db,raw,actor) {
      const out=raw as {space_id:string;user_id:string};
      if(out.user_id!==actor.on_behalf_of_user_id)throw hidden();
      if('source_refs' in out)await lockInterestSources(db,out.space_id,out.user_id,(out as typeof out & {source_refs:InterestSourceRef[]}).source_refs,id==='interest.history.backfill');
      await owner(db,actor,out.space_id);
    },
    classifyError(error) { return error instanceof HttpError || error instanceof SpaceCommandError ? markedRefusal(error,'interest') : undefined; },
    async execute(db,raw,actor) {
      const i=raw as OperationInput<typeof id>, space=actor.space_id,user=actor.on_behalf_of_user_id!;
      if('domain_key' in i && i.domain_key && !isKnownDomain(i.domain_key))throw new HttpError(422,'domain_key must name a registered domain');
      if('label' in i && i.label && !topicKeyFor(i.label))throw new HttpError(422,'topic label does not normalize to a key');
      const service=new InterestProfileService(db),base={space_id:space,user_id:user};
      switch(id) {
        case 'interest.starter_pack.apply': { const input=i as OperationInput<typeof id>; return {...base,...await new InterestStarterPackService(db).apply(space,user,input.key,undefined,starter.get(db))}; }
        case 'interest.history.backfill': { const input=i as OperationInput<typeof id>; return {...base,...await new SourceAnnotationService(db,config).backfillHistory(space,user,input.limit??500,history.get(db))}; }
        case 'interest.candidate.accept': { const input=i as OperationInput<typeof id>; return {...base,topic:topicView(await service.acceptCandidate(space,user,input.phrase_key,{label:input.label,domainKey:input.domain_key}))}; }
        case 'interest.candidate.dismiss': { const input=i as OperationInput<typeof id>; if(!await service.dismissCandidate(space,user,input.phrase_key))throw new HttpError(404,'Topic candidate not found'); return {...base,dismissed:true}; }
        case 'interest.settings.update': { const {space_id:_,...patch}=i as OperationInput<typeof id>; return {...base,settings:await service.updateSettings(space,user,patch)}; }
        case 'interest.topic.create': { const input=i as OperationInput<typeof id>; return {...base,topic:topicView(await service.createTopic(space,user,{label:input.label,domainKey:input.domain_key,weight:input.weight}))}; }
        case 'interest.topic.update': { const input=i as OperationInput<typeof id>,topic=await service.updateTopic(space,user,input.topic_key,{label:input.label,domainKey:input.domain_key,weight:input.weight}); if(!topic)throw new HttpError(404,'Interest topic not found');return {...base,topic:topicView(topic)}; }
        case 'interest.topic.archive': { const input=i as OperationInput<typeof id>; if(!await service.archiveTopic(space,user,input.topic_key))throw new HttpError(404,'Interest topic not found');return {...base,archived:true}; }
      }
    },
  }));
}
