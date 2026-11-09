import {lockSourceChannelReference} from './sourceMonitorParent.js';
import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {hidden} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {SourceChannelService} from './channels/sourceChannelService.js';
const ids=['source.channel.set_subscription','source.recommendation.decide'] as const;
type Id=typeof ids[number];type Input=OperationInput<Id>;
const identity=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function authorize(db:Queryable,channel:string,actor:OperationActor,recommendation:boolean){
  const person=identity(actor);
  // Preference authority is this person's existing subscription row. Leaving
  // does not require Source ownership or a current content read grant.
  if(recommendation&&!await lockSourceChannelReference(db,person.spaceId,channel))throw hidden();
  const target=(await db.query(`SELECT ch.id FROM source_channels ch
    ${recommendation?'JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id':''}
    WHERE ch.id=$1 AND ch.space_id=$2 AND ${recommendation?"ch.status='active' AND sc.visibility='space_shared' AND sc.deleted_at IS NULL":"ch.status<>'archived'"}
    ${recommendation?'':'FOR SHARE OF ch'}`,[channel,person.spaceId])).rows[0];
  if(!target)throw hidden();
  const owned=(await db.query(`SELECT id FROM source_channel_user_subscriptions WHERE source_channel_id=$1 AND space_id=$2 AND user_id=$3
    ${recommendation?'':"AND status IN ('subscribed','muted')"} FOR UPDATE`,[channel,person.spaceId,person.userId])).rows[0];
  if(!owned)throw hidden();
}
export function sourceSubscriptionRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return ids.map(id=>({
    definition:definitions.get(id)!,
    async resolve(_db,raw){const input=raw as Input;return {authority:`source_channel:${input.source_channel_id}`,targets:{source_channel_id:input.source_channel_id},resourceType:'source_channel',resourceId:input.source_channel_id};},
    authorize:(db,raw,actor)=>authorize(db,(raw as Input).source_channel_id,actor,id==='source.recommendation.decide'),
    authorizeResult:(db,raw,actor)=>authorize(db,(raw as {source_channel_id:string}).source_channel_id,actor,id==='source.recommendation.decide'),
    async execute(db,raw,actor){const input=raw as Input,service=new SourceChannelService(db,config),person=identity(actor);
      return 'decision' in input?service.decideRecommendation(person,input.source_channel_id,input.decision):service.setSubscription(person,input.source_channel_id,input.status);
    },
  }));
}
