import {randomUUID} from 'node:crypto';
import type {RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {admitSystemCommand,SystemCommandRefusal,type SystemCommandKindHandler} from '../systemCommands/intents.js';
import {classifySettingsError,keyedSecretFingerprint,settingsPolicyContext,user} from '../systemCommands/operationSupport.js';
import {evaluateWebhookPolicy,sendNotificationWebhook,type WebhookDispatchBody} from './service.js';

/**
 * `notification.webhook.dispatch`: any signed-in person (as before) asks for
 * one supported event to be sent to an allowlisted target. Admission checks
 * the egress policy and payload bound and commits the intent; the worker
 * sends after commit, checking the policy again. A send whose outcome was
 * never recorded is `needs_attention` and is never repeated; the event
 * payload is dropped from the intent once it settles.
 */
function dispatchBody(raw:unknown):WebhookDispatchBody{
  const i=raw as {target_url:string;event_type:string;payload?:unknown};
  return {target_url:i.target_url,event_type:i.event_type,payload:i.payload};
}
function admissible(config:ServerConfig,body:WebhookDispatchBody):void{
  const decision=evaluateWebhookPolicy(config,body);
  if(!decision.allowed)throw new SystemCommandRefusal(decision.statusCode===422?422:409,decision.message??'Notification webhook denied',{code:decision.error??'notification_webhook_denied'});
  if(Buffer.byteLength(JSON.stringify({event_type:body.event_type,payload:body.payload??null}),'utf8')>config.notificationMaxPayloadBytes){
    throw new SystemCommandRefusal(422,'Notification webhook payload is too large',{code:'notification_payload_too_large'});
  }
}
export function notificationOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return [{
    definition:definitions.get('notification.webhook.dispatch')!,successStatus:202,
    async resolve(_db,raw){return {authority:'notification_webhook',targets:{target_url:(raw as {target_url:string}).target_url},resourceType:'notification_webhook',resourceId:null};},
    async authorize(){/* Any active member of the request Space, as before (the executor's actor check). */},
    async authorizeResult(_db,raw,a){if((raw as {space_id?:string}).space_id!==a.space_id)throw hidden();},
    policyContext:settingsPolicyContext,
    fingerprintInput:input=>keyedSecretFingerprint(config,input,['target_url']),
    async execute(db,raw,a){
      const body=dispatchBody(raw);
      admissible(config,body);
      // Every send is its own command: two people's (or one person's two) events never conflict.
      return admitSystemCommand(db,{spaceId:a.space_id,userId:user(a),kind:'webhook_dispatch',scope:{send:randomUUID()},
        frozen:{target_url:body.target_url,event_type:body.event_type,payload:body.payload??null,operation_id:'notification.webhook.dispatch'}});
    },
    classifyError:error=>classifySettingsError(error,'notifications'),
  }];
}

export const NOTIFICATION_SYSTEM_COMMAND_HANDLERS={
  webhook_dispatch:{
    policy:'notification.webhook.dispatch',resourceType:'notification_webhook',resourceId:()=>null,repeatable:false,
    async authorize(){/* The issuer only needs to still be an active member (the worker's actor check). */},
    async run(config,intent){
      const frozen=intent.frozen_json as {target_url:string;event_type:string;payload?:unknown};
      return sendNotificationWebhook(config,{target_url:frozen.target_url,event_type:frozen.event_type,payload:frozen.payload});
    },
  },
} satisfies Record<string,SystemCommandKindHandler>;
