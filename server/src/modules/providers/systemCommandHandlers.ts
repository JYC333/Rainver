import {ApiPlanUsageSnapshotSchema,ModelProviderDTOSchema,ProviderTestResultSchema} from '@rainver/protocol';
import {HttpError} from '../routeUtils/common.js';
import {SystemCommandRefusal,type SystemCommandKindHandler} from '../systemCommands/intents.js';
import {authorizeProviderCommand} from './operations.js';
import {runProviderConnectionTest} from './connectionTest.js';
import {refreshApiPlanUsage} from './planUsage/service.js';
import {ManagedSubscriptionRefreshError,refreshManagedSubscriptionQuota} from './subscriptionOAuth.js';

const providerId=(intent:{frozen_json:Record<string,unknown>})=>String(intent.frozen_json.provider_id??'');
const json=<T>(value:T):Record<string,unknown>=>JSON.parse(JSON.stringify(value)) as Record<string,unknown>;
/** A vendor refusal the owning service wrote for the person (a changed Provider, an unsupported plan). */
function refused(error:unknown):never{
  // A sign-in renewal that may already have rotated the grant is never sent again: the person reconnects.
  if(error instanceof ManagedSubscriptionRefreshError&&error.code==='subscription_reconnect_required')throw new SystemCommandRefusal(409,error.message,{code:error.code});
  if(error instanceof HttpError&&[409,422].includes(error.statusCode))throw new SystemCommandRefusal(error.statusCode as 409|422,error.message,{code:'provider_refused'});
  if(error instanceof HttpError&&error.statusCode===502)throw new SystemCommandRefusal(409,error.message,{code:'provider_unavailable'});
  throw error;
}

/**
 * Provider vendor IO, performed by the system command worker after commit.
 * A connection test spends (one small completion as the person): never
 * repeated after an unknown outcome. Plan usage and subscription quota are
 * reads: repeated a bounded number of times. A quota read may first renew the
 * subscription's sign-in; that renewal is not part of what is repeated: it is
 * the credential channel's own once-only step (`resolveManagedSubscriptionCredential`),
 * recorded durably before the vendor call and settled after it, so a repeat
 * finds a renewal that is in flight (waits, then retries later), one that
 * finished (uses its tokens) or one whose outcome is unknown (a definite
 * reconnect-required refusal) and never re-sends a possibly spent token. Each
 * recheck is the operation's own admission authority (`authorizeProviderCommand`).
 */
export const PROVIDER_SYSTEM_COMMAND_HANDLERS={
  provider_test:{
    policy:'provider.manage',resourceType:'model_provider',resourceId:providerId,repeatable:false,
    authorize:(db,config,intent)=>authorizeProviderCommand(db,config,'provider_test',intent.space_id,providerId(intent),intent.user_id),
    async run(config,intent){
      return {ok:true,result:ProviderTestResultSchema.parse(await runProviderConnectionTest(config,{spaceId:intent.space_id,userId:intent.user_id},providerId(intent)))};
    },
  },
  provider_plan_usage_refresh:{
    policy:'provider.manage',resourceType:'model_provider',resourceId:providerId,repeatable:true,
    authorize:(db,config,intent)=>authorizeProviderCommand(db,config,'provider_plan_usage_refresh',intent.space_id,providerId(intent),intent.user_id),
    async run(config,intent){
      // The service rechecks the Provider's revision after the vendor wait; the settle step rechecks authority.
      const snapshot=await refreshApiPlanUsage(config,intent.space_id,intent.user_id,providerId(intent)).catch(refused);
      return {ok:true,result:json(ApiPlanUsageSnapshotSchema.parse(snapshot))};
    },
  },
  provider_subscription_quota_refresh:{
    policy:'provider.manage',resourceType:'model_provider',resourceId:providerId,repeatable:true,
    authorize:(db,config,intent)=>authorizeProviderCommand(db,config,'provider_subscription_quota_refresh',intent.space_id,providerId(intent),intent.user_id),
    async run(config,intent){
      const provider=await refreshManagedSubscriptionQuota(config,intent.space_id,intent.user_id,providerId(intent)).catch(refused);
      return {ok:true,result:json(ModelProviderDTOSchema.parse(provider))};
    },
  },
} satisfies Record<string,SystemCommandKindHandler>;
