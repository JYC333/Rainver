import {SETTINGS_COMMAND_OPERATION_KIND,type OperationActor,type RegisteredSystemActionDefinition,type SettingsCommandOperationId} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,OperationRefusal} from '../systemActions/operations/errors.js';
import {isInstanceAdminIn,isSpaceOwnerOrAdminIn} from '../routeUtils/access.js';
import {resetAndQueueRetrievalEmbeddingsIn} from '../retrieval/embedding/job.js';
import {RETRIEVAL_EMBEDDING_TASK} from '../retrieval/embedding/config.js';
import {admitSystemCommand,SystemCommandRefusal} from '../systemCommands/intents.js';
import {classifySettingsError,keyedSecretFingerprint,settingsPolicyContext,user} from '../systemCommands/operationSupport.js';
import {providerCommandStoreIn,ProviderCommandForbiddenError} from './commands/store.js';
import {createProviderFromPreset} from './commands/fromPreset.js';
import {providersDbPortIn} from './dbReader.js';
import {disconnectManagedSubscriptionIn} from './subscriptionOAuth.js';
import {writeSubscriptionQuotaPolicyIn} from './subscriptionQuotaPolicy.js';
import {assertPlanUsageProviderIn} from './planUsage/service.js';

/**
 * Provider block of the settings operations (`SYSTEM_ACTIONS.md` "System
 * settings and tool configuration commands"). Every write goes through the
 * existing `ProviderCommandStore` bound to the operation transaction, so the
 * Provider, its grants, its encrypted key and its pool commit with the
 * audit and the receipt. API keys only ever reach `credentials.secret_ref`
 * through the store's encryption: no output, receipt, audit context, Job or
 * intent carries one, and the request fingerprint keys them (`fingerprintInput`).
 */
type Input=Record<string,unknown>;
type DirectId='provider.create'|'provider.create_from_preset'|'provider.update'|'provider.delete'|'provider.credential.add'|'provider.credential.remove'
  |'provider.pool_config.update'|'provider.grant.set'|'provider.grant.revoke'|'provider.task_policy.set'|'provider.task_policy.delete'
  |'provider.subscription_quota_policy.set'|'provider.subscription.disconnect';
type CommandId=Extract<SettingsCommandOperationId,`provider.${string}`>;
const DIRECT:readonly DirectId[]=['provider.create','provider.create_from_preset','provider.update','provider.delete','provider.credential.add','provider.credential.remove',
  'provider.pool_config.update','provider.grant.set','provider.grant.revoke','provider.task_policy.set','provider.task_policy.delete',
  'provider.subscription_quota_policy.set','provider.subscription.disconnect'];
const SPACE_POLICY=new Set<string>(['provider.task_policy.set','provider.task_policy.delete','provider.subscription_quota_policy.set']);
const SECRET_FIELDS=['api_key'] as const;
const json=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;

/** The person's own Provider row, share-locked for the transaction; anyone else gets the hidden 404. */
async function lockOwnedProvider(db:Queryable,providerId:string,userId:string):Promise<{space_id:string}>{
  const row=(await db.query<{space_id:string}>('SELECT space_id FROM model_providers WHERE id=$1 AND owner_user_id=$2 FOR SHARE',[providerId,userId])).rows[0];
  if(!row)throw hidden();
  return row;
}
/**
 * A managed subscription the instance admin owns in this Space (`credentials.md`).
 * `connected` also requires its OAuth credential (a quota read spends it). A
 * disconnect's authority is only the admin and the ownership: the Provider row
 * and its managed-channel marker outlive the credential, so a same-key replay
 * after a successful disconnect is still admitted, while a disconnect of an
 * already disconnected subscription is refused by the disconnect itself.
 */
export async function lockManagedSubscriptionProvider(db:Queryable,config:ServerConfig,spaceId:string,providerId:string,userId:string,{connected=true}:{connected?:boolean}={}):Promise<void>{
  if(!await isInstanceAdminIn(db,config,userId))throw hidden();
  const row=(await db.query(connected
    ?`SELECT 1 FROM model_providers p JOIN credentials c ON c.id=p.credential_id AND c.credential_type='subscription_oauth'
       WHERE p.id=$1 AND p.space_id=$2 AND p.owner_user_id=$3 FOR SHARE OF p`
    :`SELECT 1 FROM model_providers p LEFT JOIN credentials c ON c.id=p.credential_id
       WHERE p.id=$1 AND p.space_id=$2 AND p.owner_user_id=$3
         AND (c.credential_type='subscription_oauth' OR p.config_json->>'credential_channel'='managed_subscription_oauth')
       FOR SHARE OF p`,[providerId,spaceId,userId])).rows[0];
  if(!row)throw hidden();
}
/**
 * A grant revoke's writer: the Provider's owner, or an owner/admin of the
 * Space the grant is in (the store's own first-write rule). Read now, at
 * admission, at every same-key replay and before a result is released; it
 * rests on the Provider row and the target Space (both outlive the grant),
 * never on the grant row still existing.
 */
async function assertGrantRevokerIn(db:Queryable,providerId:string,targetSpaceId:string,userId:string):Promise<void>{
  if((await db.query('SELECT 1 FROM model_providers WHERE id=$1 AND owner_user_id=$2 FOR SHARE',[providerId,userId])).rows.length)return;
  if(!targetSpaceId||!await isSpaceOwnerOrAdminIn(db,targetSpaceId,userId))throw hidden();
  if(!(await db.query('SELECT 1 FROM model_providers WHERE id=$1 FOR SHARE',[providerId])).rows.length)throw hidden();
}
/** A Provider this person can see in this Space (the connection test's authority: they spend it as themselves). */
export async function assertTestableProviderIn(db:Queryable,spaceId:string,providerId:string,userId:string):Promise<void>{
  if(!await providersDbPortIn(db).getProvider(spaceId,userId,providerId))throw hidden();
}

/** Refusals a Provider's owner may read; every other forbidden write stays the hidden 404. */
const OWNER_REFUSALS=[/^Managed subscription providers cannot be granted/,/^Only a Space owner or admin can declare/];
function classify(error:unknown){
  if(error instanceof ProviderCommandForbiddenError&&OWNER_REFUSALS.some(pattern=>pattern.test(error.message)))return new OperationRefusal(409,'providers',error.message);
  return classifySettingsError(error,'providers');
}

export function providerOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  const direct=DIRECT.map((id):OperationRegistration=>({
    definition:definitions.get(id)!,
    ...(id==='provider.create'||id==='provider.create_from_preset'||id==='provider.credential.add'?{successStatus:201 as const}:{}),
    async resolve(_db,raw,a){
      const i=raw as Input;
      const target=typeof i.provider_id==='string'?i.provider_id:null;
      return SPACE_POLICY.has(id)
        ?{authority:`space:${a.space_id}`,targets:{space_id:a.space_id,task:i.task??null},resourceType:'space',resourceId:a.space_id}
        :{authority:target?`model_provider:${target}`:`space:${a.space_id}`,targets:{provider_id:target,member_id:i.member_id??null,target_space_id:i.target_space_id??null},resourceType:'model_provider',resourceId:target};
    },
    async authorize(db,raw,a){
      const i=raw as Input;
      if(SPACE_POLICY.has(id)){if(!await isSpaceOwnerOrAdminIn(db,a.space_id,user(a)))throw hidden();return;}
      if(id==='provider.subscription.disconnect'){await lockManagedSubscriptionProvider(db,config,a.space_id,String(i.provider_id),user(a),{connected:false});return;}
      if(id==='provider.grant.revoke'){await assertGrantRevokerIn(db,String(i.provider_id),String(i.target_space_id??''),user(a));return;}
      if(typeof i.provider_id==='string')await lockOwnedProvider(db,i.provider_id,user(a));
    },
    async authorizeResult(db,raw,a){
      const out=raw as Input&{provider?:Input};
      if(SPACE_POLICY.has(id)){if(!await isSpaceOwnerOrAdminIn(db,a.space_id,user(a)))throw hidden();return;}
      if(id==='provider.subscription.disconnect'){await lockManagedSubscriptionProvider(db,config,a.space_id,String(out.id),user(a),{connected:false});return;}
      if(id==='provider.grant.revoke'){await assertGrantRevokerIn(db,String(out.provider_id),String(out.target_space_id),user(a));return;}
      // A completed removal is released to whoever made it while they still own the Provider
      // (admission rechecked that ownership: a deleted Provider keeps its row, disabled).
      if(['provider.delete','provider.credential.add','provider.credential.remove'].includes(id))return;
      const providerId=typeof out.provider?.id==='string'?out.provider.id:typeof out.provider_id==='string'&&id!=='provider.grant.set'?out.provider_id:id==='provider.grant.set'?String(out.provider_id):String(out.id);
      await lockOwnedProvider(db,providerId,user(a));
    },
    policyContext:settingsPolicyContext,
    fingerprintInput:input=>keyedSecretFingerprint(config,input,SECRET_FIELDS),
    async execute(db,raw,a){
      const i=raw as Input,store=providerCommandStoreIn(config,db),u=user(a);
      const providerId=String(i.provider_id??'');
      const {provider_id:_p,...body}=i;
      switch(id){
        case 'provider.create':return json(await store.createProvider(a.space_id,u,body as never));
        case 'provider.create_from_preset':return json(await createProviderFromPreset(db,store,a.space_id,u,body as never));
        case 'provider.update':return json(await store.updateProvider(a.space_id,u,providerId,body as never));
        case 'provider.delete':await store.deleteProvider(a.space_id,u,providerId);return {provider_id:providerId,space_id:a.space_id,deleted:true};
        case 'provider.credential.add':return json(await store.addPoolCredential(a.space_id,u,providerId,body as never));
        case 'provider.credential.remove':await store.removePoolCredential(a.space_id,u,providerId,String(i.member_id));return {provider_id:providerId,member_id:String(i.member_id),space_id:a.space_id,removed:true};
        case 'provider.pool_config.update':return json(await store.updatePoolConfig(a.space_id,u,providerId,body as never));
        case 'provider.grant.set':return json(await store.grantProviderToSpace(a.space_id,u,providerId,body as never));
        case 'provider.grant.revoke':await store.revokeProviderGrant(a.space_id,u,providerId,String(i.target_space_id));return {provider_id:providerId,target_space_id:String(i.target_space_id),space_id:a.space_id,revoked:true};
        case 'provider.task_policy.set':{
          const task=String(i.task);
          const updated=json(await store.putTaskPolicy(a.space_id,u,task,i.chain as never,i.enabled as boolean|undefined));
          if(task===RETRIEVAL_EMBEDDING_TASK)await resetAndQueueRetrievalEmbeddingsIn(db,{spaceId:a.space_id,userId:u,trigger:'retrieval_embedding_policy_update'});
          return updated;
        }
        case 'provider.task_policy.delete':{
          const task=String(i.task);
          await store.deleteTaskPolicy(a.space_id,u,task);
          if(task===RETRIEVAL_EMBEDDING_TASK)await resetAndQueueRetrievalEmbeddingsIn(db,{spaceId:a.space_id,userId:u,trigger:'retrieval_embedding_policy_delete'});
          return {task,space_id:a.space_id,deleted:true};
        }
        case 'provider.subscription_quota_policy.set':return writeSubscriptionQuotaPolicyIn(db,a.space_id,u,{warn_pct:Number(i.warn_pct),reserve_pct:Number(i.reserve_pct)});
        case 'provider.subscription.disconnect':return json(await disconnectManagedSubscriptionIn(db,a.space_id,u,providerId));
      }
    },
    classifyError:classify,
  }));
  const commands=(['provider.test','provider.plan_usage.refresh','provider.subscription.quota.refresh'] as CommandId[]).map((id):OperationRegistration=>({
    definition:definitions.get(id)!,successStatus:202,
    async resolve(_db,raw){const i=raw as Input;return {authority:`model_provider:${i.provider_id}`,targets:{provider_id:i.provider_id},resourceType:'model_provider',resourceId:String(i.provider_id)};},
    async authorize(db,raw,a){await authorizeProviderCommand(db,config,id,a.space_id,String((raw as Input).provider_id),user(a));},
    async authorizeResult(db,raw,a){
      const out=raw as {space_id:string};
      if(out.space_id!==a.space_id)throw hidden();
    },
    policyContext:settingsPolicyContext,
    async execute(db,raw,a){
      const providerId=String((raw as Input).provider_id);
      const kind=SETTINGS_COMMAND_OPERATION_KIND[id];
      if(id==='provider.plan_usage.refresh'&&!(await assertPlanUsageProviderIn(db,a.space_id,user(a),providerId)).supported){
        throw new SystemCommandRefusal(422,'This provider has no supported plan usage endpoint',{code:'plan_usage_unsupported'});
      }
      // A connection test or plan read is the person's own; a subscription quota read is the Provider's.
      const scope=kind==='provider_subscription_quota_refresh'?{provider_id:providerId}:{provider_id:providerId,user_id:user(a),space_id:a.space_id};
      return admitSystemCommand(db,{spaceId:a.space_id,userId:user(a),kind,scope,frozen:{provider_id:providerId,operation_id:id}});
    },
    classifyError:classify,
  }));
  return [...direct,...commands];
}

/** The authority each Provider system command is admitted and rechecked under. */
export async function authorizeProviderCommand(db:Queryable,config:ServerConfig,id:CommandId|'provider_test'|'provider_plan_usage_refresh'|'provider_subscription_quota_refresh',spaceId:string,providerId:string,userId:string):Promise<void>{
  if(id==='provider.test'||id==='provider_test')return assertTestableProviderIn(db,spaceId,providerId,userId);
  if(id==='provider.plan_usage.refresh'||id==='provider_plan_usage_refresh'){await assertPlanUsageProviderIn(db,spaceId,userId,providerId);return;}
  return lockManagedSubscriptionProvider(db,config,spaceId,providerId,userId);
}

export type {OperationActor};
