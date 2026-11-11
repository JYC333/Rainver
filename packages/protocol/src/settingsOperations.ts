import {z} from 'zod';
import {IdSchema,SecretResponseGuards} from './common.js';
import {
  ModelProviderCreateRequestSchema,ModelProviderDTOSchema,ModelProviderSpaceGrantDTOSchema,ModelProviderSpaceGrantRequestSchema,
  ModelProviderUpdateRequestSchema,ProviderFromPresetCreateRequestSchema,ProviderFromPresetCreateResponseSchema,
} from './providers.js';
import {
  ProviderPoolConfigUpdateRequestSchema,ProviderPoolCredentialAddRequestSchema,ProviderPoolMemberDTOSchema,ProviderPoolResponseSchema,
  ProviderTaskPolicyDTOSchema,ProviderTaskPolicyPutRequestSchema,
} from './providerCredentialsRuntime.js';
import {SubscriptionQuotaPolicySchema} from './subscriptionQuota.js';
import {NetworkProfileCreateRequestSchema,NetworkProfileDTOSchema,NetworkProfileUpdateRequestSchema} from './networkProfiles.js';
import {InstanceOperationsSettingsSchema,InstanceOperationsSettingsUpdateSchema} from './instanceOperations.js';
import {DeploymentJobCreateSchema,DeploymentJobSchema} from './deployment.js';
import {SourceConnectorSchema} from './sourceChannels.js';

/**
 * System settings and tool configuration block of the operation core (P5,
 * `.agent/architecture/SYSTEM_ACTIONS.md` "System settings and tool
 * configuration commands"). Every command a person gives about the instance's
 * Providers, network profiles, ACP registry, plugins, backups, operating
 * settings, Source catalog, deployments or notification webhooks is one core
 * operation. Commands whose effect is vendor, filesystem or network IO commit a
 * durable system command intent plus its Job and answer 202 with this
 * receipt; the worker performs the effect outside every transaction and the
 * status read (`GET /api/v1/system/commands/:commandId`) is the only place the
 * outcome is released. An effect the control plane cannot prove is
 * `needs_attention`, never `succeeded`.
 */
const id=IdSchema.max(36);
const key=z.string().trim().min(1).max(120);
const deleted=<T extends z.ZodRawShape>(shape:T)=>z.object({...shape,space_id:id}).strict();

export const SYSTEM_COMMAND_KINDS=[
  'provider_test','provider_plan_usage_refresh','provider_subscription_quota_refresh','plugin_install','backup_manual','webhook_dispatch',
] as const;
export const SystemCommandKindSchema=z.enum(SYSTEM_COMMAND_KINDS);
export type SystemCommandKind=z.infer<typeof SystemCommandKindSchema>;
export const SYSTEM_COMMAND_STATUSES=['pending','dispatched','succeeded','failed','needs_attention'] as const;
export const SystemCommandStatusValueSchema=z.enum(SYSTEM_COMMAND_STATUSES);
export type SystemCommandStatusValue=z.infer<typeof SystemCommandStatusValueSchema>;

/** What a system command answers when it is admitted: an intent, never an outcome. */
export const SystemCommandReceiptSchema=z.object({
  id,space_id:id,kind:SystemCommandKindSchema,job_id:id,status:z.literal('pending'),
}).strict();
export type SystemCommandReceipt=z.infer<typeof SystemCommandReceiptSchema>;

/** The issuer-only status read of one system command. `result` is the kind's frozen outcome once settled. */
export const SystemCommandStatusSchema=z.object({
  id,space_id:id,kind:SystemCommandKindSchema,job_id:id,status:SystemCommandStatusValueSchema,
  error:z.object({code:z.string().min(1).max(120),detail:z.string().max(1000).nullable()}).strict().nullable(),
  result:z.record(z.unknown()).nullable(),
  created_at:z.string(),updated_at:z.string(),
  ...SecretResponseGuards,
}).strict();
export type SystemCommandStatus=z.infer<typeof SystemCommandStatusSchema>;

/** The settled result of each kind, as the legacy synchronous route answered it. */
export const ProviderTestResultSchema=z.object({success:z.boolean(),message:z.string(),model:z.string().nullish()}).strict();
export const PluginInstallResultSchema=z.object({install:z.record(z.unknown()),item:z.record(z.unknown())}).strict();
export const BackupCreateResultSchema=z.object({status:z.literal('ok'),backup:z.string().min(1)}).strict();
export const WebhookDispatchResultSchema=z.object({delivered:z.boolean(),target_origin:z.string(),upstream_status:z.number().int()}).strict();

const PluginItemSchema=z.object({descriptor:z.record(z.unknown()),effective:z.record(z.unknown())}).passthrough();
const AcpAgentSchema=z.object({id:z.string().min(1),runtime_key:z.string().min(1),installed_on:z.array(z.object({host_id:id,name:z.string()}).strict())}).passthrough();
const CatalogRowSchema=z.object({id:z.string().min(1),status:z.string().min(1)}).passthrough();
const provider={provider_id:id};

export const SETTINGS_COMMAND_OPERATION_SCHEMAS={
  'provider.test':{input:z.object(provider).strict(),output:SystemCommandReceiptSchema},
  'provider.plan_usage.refresh':{input:z.object(provider).strict(),output:SystemCommandReceiptSchema},
  'provider.subscription.quota.refresh':{input:z.object(provider).strict(),output:SystemCommandReceiptSchema},
  'official_plugin.install':{input:z.object({plugin_id:key}).strict(),output:SystemCommandReceiptSchema},
  'system.backup.create':{input:z.object({}).strict(),output:SystemCommandReceiptSchema},
  'notification.webhook.dispatch':{input:z.object({target_url:z.string().min(1).max(2048),event_type:z.string().min(1).max(120),payload:z.unknown().optional()}).strict(),output:SystemCommandReceiptSchema},
} as const;

/** Commands that are complete in their own transaction. */
export const SETTINGS_DIRECT_OPERATION_SCHEMAS={
  'provider.create':{input:ModelProviderCreateRequestSchema.strict(),output:ModelProviderDTOSchema},
  'provider.create_from_preset':{input:ProviderFromPresetCreateRequestSchema.strict(),output:ProviderFromPresetCreateResponseSchema},
  'provider.update':{input:ModelProviderUpdateRequestSchema.extend(provider).strict(),output:ModelProviderDTOSchema},
  'provider.delete':{input:z.object(provider).strict(),output:deleted({...provider,deleted:z.literal(true)})},
  'provider.credential.add':{input:ProviderPoolCredentialAddRequestSchema.extend(provider).strict(),output:ProviderPoolMemberDTOSchema},
  'provider.credential.remove':{input:z.object({...provider,member_id:id}).strict(),output:deleted({...provider,member_id:id,removed:z.literal(true)})},
  'provider.pool_config.update':{input:ProviderPoolConfigUpdateRequestSchema.extend(provider).strict(),output:ProviderPoolResponseSchema},
  'provider.grant.set':{input:ModelProviderSpaceGrantRequestSchema.extend(provider).strict(),output:ModelProviderSpaceGrantDTOSchema},
  'provider.grant.revoke':{input:z.object({...provider,target_space_id:id}).strict(),output:deleted({...provider,target_space_id:id,revoked:z.literal(true)})},
  'provider.task_policy.set':{input:ProviderTaskPolicyPutRequestSchema.extend({task:key}).strict(),output:ProviderTaskPolicyDTOSchema},
  'provider.task_policy.delete':{input:z.object({task:key}).strict(),output:deleted({task:key,deleted:z.literal(true)})},
  'provider.subscription_quota_policy.set':{input:z.object({warn_pct:z.number().int().min(1).max(100),reserve_pct:z.number().int().min(1).max(100)}).strict().refine(p=>p.warn_pct<=p.reserve_pct,{message:'warn_pct must not be above reserve_pct',path:['warn_pct']}),output:SubscriptionQuotaPolicySchema},
  'provider.subscription.disconnect':{input:z.object(provider).strict(),output:ModelProviderDTOSchema},
  'network_profile.create':{input:NetworkProfileCreateRequestSchema.strict(),output:NetworkProfileDTOSchema},
  'network_profile.update':{input:NetworkProfileUpdateRequestSchema.extend({profile_id:id}).strict(),output:NetworkProfileDTOSchema},
  'network_profile.delete':{input:z.object({profile_id:id}).strict(),output:deleted({profile_id:id,deleted:z.literal(true)})},
  'acp_agent.enable':{input:z.object({registry_id:z.string().trim().min(1).max(60)}).strict(),output:AcpAgentSchema},
  'acp_agent.disable':{input:z.object({registry_id:z.string().trim().min(1).max(60)}).strict(),output:deleted({registry_id:z.string(),disabled:z.literal(true)})},
  'official_plugin.enable':{input:z.object({plugin_id:key,settings:z.record(z.unknown()).optional()}).strict(),output:PluginItemSchema},
  'official_plugin.disable':{input:z.object({plugin_id:key}).strict(),output:PluginItemSchema},
  'official_plugin.settings.update':{input:z.object({plugin_id:key,settings:z.record(z.unknown())}).strict(),output:PluginItemSchema},
  'system.instance_settings.update':{input:InstanceOperationsSettingsUpdateSchema,output:InstanceOperationsSettingsSchema},
  'source_catalog.provider.update':{input:z.object({provider_id:id,status:z.enum(['active','disabled']).optional()}).strict(),output:CatalogRowSchema},
  'source_catalog.connector.update':{input:z.object({connector_id:id,status:z.enum(['active','disabled']).optional()}).strict(),output:SourceConnectorSchema},
  'source_catalog.mapping.update':{input:z.object({mapping_id:id,status:z.enum(['active','disabled']).optional(),priority:z.number().int().nonnegative().optional()}).strict(),output:CatalogRowSchema},
  'deployment.job.create':{input:DeploymentJobCreateSchema,output:DeploymentJobSchema},
  'deployment.job.cancel':{input:z.object({job_id:id}).strict(),output:DeploymentJobSchema},
} as const;

export type SettingsCommandOperationId=keyof typeof SETTINGS_COMMAND_OPERATION_SCHEMAS;
export type SettingsDirectOperationId=keyof typeof SETTINGS_DIRECT_OPERATION_SCHEMAS;

export const SETTINGS_OPERATION_TITLES:Record<SettingsCommandOperationId|SettingsDirectOperationId,string>={
  'provider.test':'Test a Provider connection',
  'provider.plan_usage.refresh':"Read an API Provider's plan usage",
  'provider.subscription.quota.refresh':"Read a managed subscription's quota",
  'official_plugin.install':'Install an official plugin package',
  'system.backup.create':'Create a manual instance backup',
  'notification.webhook.dispatch':'Send a notification webhook',
  'provider.create':'Create a model Provider',
  'provider.create_from_preset':'Create a model Provider from a preset',
  'provider.update':'Update a model Provider',
  'provider.delete':'Delete a model Provider',
  'provider.credential.add':"Add an API key to a Provider's credential pool",
  'provider.credential.remove':"Remove an API key from a Provider's credential pool",
  'provider.pool_config.update':"Change a Provider's rotation and fallback",
  'provider.grant.set':'Grant a Provider to a Space',
  'provider.grant.revoke':"Revoke a Provider's Space grant",
  'provider.task_policy.set':'Set an auxiliary task Provider chain',
  'provider.task_policy.delete':'Remove an auxiliary task Provider chain',
  'provider.subscription_quota_policy.set':"Set a Space's subscription quota lines",
  'provider.subscription.disconnect':'Disconnect a managed subscription',
  'network_profile.create':'Create a network profile',
  'network_profile.update':'Update a network profile',
  'network_profile.delete':'Delete a network profile',
  'acp_agent.enable':'Enable an ACP registry agent on this instance',
  'acp_agent.disable':'Disable an ACP registry agent on this instance',
  'official_plugin.enable':'Enable an official plugin',
  'official_plugin.disable':'Disable an official plugin',
  'official_plugin.settings.update':"Change an official plugin's settings",
  'system.instance_settings.update':'Change instance operating settings',
  'source_catalog.provider.update':'Change an instance Source provider',
  'source_catalog.connector.update':'Change an instance Source connector',
  'source_catalog.mapping.update':'Change an instance Source provider connector mapping',
  'deployment.job.create':'Create an instance deployment job',
  'deployment.job.cancel':'Cancel a queued deployment job',
};

/** Which command kind each settings operation admits. */
export const SETTINGS_COMMAND_OPERATION_KIND:Record<SettingsCommandOperationId,SystemCommandKind>={
  'provider.test':'provider_test',
  'provider.plan_usage.refresh':'provider_plan_usage_refresh',
  'provider.subscription.quota.refresh':'provider_subscription_quota_refresh',
  'official_plugin.install':'plugin_install',
  'system.backup.create':'backup_manual',
  'notification.webhook.dispatch':'webhook_dispatch',
};
