import {z} from 'zod';
import {OrdinaryToolIdSchema} from './ordinaryTools.js';
import {OrdinaryAccountToolIdSchema} from './ordinaryToolAccounts.js';
import {AmbientImportPolicySchema,ImportedSessionSchema} from './ambientSessions.js';

/**
 * Host block of the operation core (P5, `.agent/modules/hosts.md` "Host
 * commands"). Every command a person gives about a Host, its Locations or its
 * imported history is one core operation. Commands with a Host effect commit a
 * durable Host command intent plus its Job and answer 202 with this receipt;
 * the worker performs the Host request outside every transaction, and the
 * status read (`GET /api/v1/hosts/:hostId/commands/:commandId`) is the only
 * place the outcome is released. An effect whose outcome the control plane
 * cannot prove is `needs_attention`, never `succeeded`.
 */
const id=z.string().trim().min(1).max(36);
const host={host_id:id};
const runtimeKey=z.string().trim().min(1).max(64);
const installation=z.string().trim().min(1).max(64);

export const HOST_COMMAND_KINDS=[
  'workspace_register','runtime_install','runtime_uninstall','runtime_own_update','runtime_managed_update',
  'runtime_rollback','runtime_usage_refresh','ordinary_tool_install','ordinary_tool_register','ordinary_tool_remove',
  'ordinary_account_logout','agent_host_state_reset','ambient_sync',
] as const;
export const HostCommandKindSchema=z.enum(HOST_COMMAND_KINDS);
export type HostCommandKind=z.infer<typeof HostCommandKindSchema>;
export const HOST_COMMAND_STATUSES=['pending','dispatched','succeeded','failed','needs_attention'] as const;
export const HostCommandStatusValueSchema=z.enum(HOST_COMMAND_STATUSES);
export type HostCommandStatusValue=z.infer<typeof HostCommandStatusValueSchema>;

/** What a Host command answers when it is admitted: an intent, never an outcome. */
export const HostCommandReceiptSchema=z.object({
  id,space_id:id,host_id:id,kind:HostCommandKindSchema,job_id:id,status:z.literal('pending'),
}).strict();
export type HostCommandReceipt=z.infer<typeof HostCommandReceiptSchema>;

/** The owner-only status read of one Host command. `result` is the kind's frozen outcome once succeeded. */
export const HostCommandStatusSchema=z.object({
  id,space_id:id,host_id:id,kind:HostCommandKindSchema,job_id:id,status:HostCommandStatusValueSchema,
  error:z.object({code:z.string().min(1).max(120),detail:z.string().max(1000).nullable()}).strict().nullable(),
  result:z.record(z.unknown()).nullable(),
  created_at:z.string(),updated_at:z.string(),
}).strict();
export type HostCommandStatus=z.infer<typeof HostCommandStatusSchema>;

const absolutePath=z.string().min(1).max(4096).refine(value=>!value.includes('\0'),'path must not contain NUL');
const visibility=z.enum(['private','space_shared']);

export const HOST_COMMAND_OPERATION_SCHEMAS={
  'host.workspace.register':{input:z.object({...host,project_id:id,path:absolutePath,name:z.string().trim().min(1).max(120)}).strict(),output:HostCommandReceiptSchema},
  'host.runtime.install':{input:z.object({...host,runtime_key:runtimeKey,expected_version:z.string().trim().min(1).max(64).optional()}).strict(),output:HostCommandReceiptSchema},
  'host.runtime.uninstall':{input:z.object({...host,runtime_key:runtimeKey,installation}).strict(),output:HostCommandReceiptSchema},
  'host.runtime.own_update':{input:z.object({...host,runtime_key:runtimeKey}).strict(),output:HostCommandReceiptSchema},
  'host.runtime.managed_update':{input:z.object({...host,runtime_key:runtimeKey}).strict(),output:HostCommandReceiptSchema},
  'host.runtime.rollback':{input:z.object({...host,runtime_key:runtimeKey}).strict(),output:HostCommandReceiptSchema},
  'host.runtime.usage.refresh':{input:z.object({...host,runtime_key:runtimeKey,installation}).strict(),output:HostCommandReceiptSchema},
  'host.ordinary_tool.install':{input:z.object({...host,tool_id:OrdinaryToolIdSchema}).strict(),output:HostCommandReceiptSchema},
  'host.ordinary_tool.register':{input:z.object({...host,tool_id:OrdinaryToolIdSchema,path:absolutePath.nullable().optional()}).strict(),output:HostCommandReceiptSchema},
  'host.ordinary_tool.remove':{input:z.object({...host,tool_id:OrdinaryToolIdSchema,source:z.enum(['managed','registered'])}).strict(),output:HostCommandReceiptSchema},
  'host.ordinary_tool.account.logout':{input:z.object({...host,tool_id:OrdinaryAccountToolIdSchema}).strict(),output:HostCommandReceiptSchema},
  'agent.host_state.reset':{input:z.object({agent_id:id,...host}).strict(),output:HostCommandReceiptSchema},
  'host.location.ambient.sync':{input:z.object({location_id:id,runtime_key:runtimeKey,installation:installation.optional(),session_ids:z.array(z.string().min(1).max(256)).max(500).nullable().optional(),visibility:visibility.optional()}).strict(),output:HostCommandReceiptSchema},
} as const;

/** Host commands that are complete in their own transaction. */
export const HOST_DIRECT_OPERATION_SCHEMAS={
  'host.runtime.provisioning.retry':{input:z.object(host).strict(),output:z.object({...host,space_id:id,runtime_key:z.literal('opencode'),state:z.enum(['queued','installing']),desired_version:z.string()}).strict()},
  'host.provider_proxy.set':{input:z.object({...host,base_url:z.string().max(512).nullable()}).strict(),output:z.object({...host,space_id:id,provider_proxy_base_url:z.string().nullable()}).strict()},
  'host.revoke':{input:z.object(host).strict(),output:z.object({...host,space_id:id,revoked:z.literal(true)}).strict()},
  'host.location.ambient.policy.set':{input:z.object({location_id:id,runtime_key:runtimeKey,installation:installation.optional(),sync:z.boolean(),default_visibility:visibility.nullable().optional(),auto_extract:z.boolean().optional()}).strict(),output:z.object({location_id:id,space_id:id,policy:AmbientImportPolicySchema}).strict()},
  'host.location.ambient.dismiss':{input:z.object({location_id:id}).strict(),output:z.object({location_id:id,space_id:id,policy:AmbientImportPolicySchema}).strict()},
  'imported_session.visibility.set':{input:z.object({session_id:id,visibility}).strict(),output:z.object({space_id:id,session:ImportedSessionSchema}).strict()},
  'imported_session.delete':{input:z.object({session_ids:z.array(id).min(1).max(200)}).strict(),output:z.object({space_id:id,deleted:z.number().int().nonnegative()}).strict()},
} as const;

export const HOST_OPERATION_TITLES:Record<keyof typeof HOST_COMMAND_OPERATION_SCHEMAS|keyof typeof HOST_DIRECT_OPERATION_SCHEMAS,string>={
  'host.workspace.register':'Register a directory on an owned Host as a Project Location',
  'host.runtime.install':'Install a managed Runtime copy on a Host',
  'host.runtime.uninstall':'Remove a managed Runtime copy from a Host',
  'host.runtime.own_update':'Update the machine-owned CLI on a paired Host',
  'host.runtime.managed_update':'Update a managed native CLI on a Host',
  'host.runtime.rollback':'Roll a managed Runtime copy back to its kept version',
  'host.runtime.usage.refresh':'Probe one Runtime copy for its subscription quota',
  'host.ordinary_tool.install':'Install a managed ordinary CLI tool on a Host',
  'host.ordinary_tool.register':'Register the machine copy of an ordinary CLI tool',
  'host.ordinary_tool.remove':'Remove an ordinary CLI tool from a Host',
  'host.ordinary_tool.account.logout':'Log out of your own ordinary CLI account on a Host',
  'agent.host_state.reset':"Clear an Agent's CLI state on an owned Host",
  'host.location.ambient.sync':'Import CLI session history from a Location',
  'host.runtime.provisioning.retry':'Retry the built-in Host OpenCode provisioning',
  'host.provider_proxy.set':"Set a paired Host's provider proxy address",
  'host.revoke':'Revoke a paired Host',
  'host.location.ambient.policy.set':'Set a Location history import policy',
  'host.location.ambient.dismiss':'Dismiss a Location history import offer',
  'imported_session.visibility.set':'Change an imported session visibility',
  'imported_session.delete':'Delete imported sessions',
};

/** Which command kind each Host operation admits. */
export const HOST_COMMAND_OPERATION_KIND:Record<keyof typeof HOST_COMMAND_OPERATION_SCHEMAS,HostCommandKind>={
  'host.workspace.register':'workspace_register',
  'host.runtime.install':'runtime_install',
  'host.runtime.uninstall':'runtime_uninstall',
  'host.runtime.own_update':'runtime_own_update',
  'host.runtime.managed_update':'runtime_managed_update',
  'host.runtime.rollback':'runtime_rollback',
  'host.runtime.usage.refresh':'runtime_usage_refresh',
  'host.ordinary_tool.install':'ordinary_tool_install',
  'host.ordinary_tool.register':'ordinary_tool_register',
  'host.ordinary_tool.remove':'ordinary_tool_remove',
  'host.ordinary_tool.account.logout':'ordinary_account_logout',
  'agent.host_state.reset':'agent_host_state_reset',
  'host.location.ambient.sync':'ambient_sync',
};
