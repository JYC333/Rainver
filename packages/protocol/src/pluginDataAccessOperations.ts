import {z} from 'zod';
import {IdSchema,ISODateTimeSchema} from './common.js';
/** Data-side consent for an Agent to reach personal/sensitive plugin data (ADR 0030). Content-free. */
const pin=z.object({action_id:z.string().min(1).max(128),action_version:z.number().int().positive(),data_class:z.enum(['non_sensitive','personal','sensitive']),side_effects:z.enum(['none','durable','proposal']),gate_class:z.string().nullable()}).strict();
const diff=z.object({added:z.array(z.string()),removed:z.array(z.string()),changed:z.array(z.string())}).strict();
const grant=z.object({
 id:IdSchema,space_id:IdSchema,plugin_id:z.string().min(1).max(24),toolset:z.enum(['read','write']),data_class:z.enum(['personal','sensitive']),
 scope:z.enum(['space','run','background','project']),data_owner_user_id:IdSchema.nullable(),granted_by_user_id:IdSchema,target_run_id:IdSchema.nullable(),
 /**
  * `project` scope (ADR 0033, core data tools only): the Project, the owner's connection and the purpose it is bound to —
  * an on-demand mail read, or a scheduled digest's read (`daily_digest`/`rule_digest`, phase B) or an application-update automation's (`application_update`, ADR 0034). The set matches the
  * `ck_plugin_data_grants_shape` check, so every stored consent can be listed and revoked.
  */
 project_id:IdSchema.nullable(),connection_id:IdSchema.nullable(),purpose:z.enum(['on_demand_read','daily_digest','rule_digest','application_update']).nullable(),
 plugin_version:z.string(),authority_hash:z.string(),expanded:z.array(pin),
 status:z.enum(['active','revoked','expired']),expires_at:ISODateTimeSchema.nullable(),revoked_at:ISODateTimeSchema.nullable(),
 created_at:ISODateTimeSchema,
 /** Present on list: tools changed by an upgrade since consent stay inactive until a new grant is written. */
 reconsent:diff.nullable().optional(),
}).strict();
/**
 * A consent the caller may give now, from the canonical toolset expansion and the
 * writer's own rules: personal Space-wide (Space owner), or the caller's own
 * read-only background consent for their scheduled Runs (sensitive). `tools` is
 * what the grant would freeze; `changes` compares it with this key's latest grant.
 * `authority_hash` is the composed package's contract identity those tools were
 * expanded from (the hash a grant pins); `create` must echo it back.
 */
const option=z.object({
 plugin_id:z.string().min(1).max(24),plugin_name:z.string(),plugin_version:z.string(),toolset:z.enum(['read','write']),data_class:z.enum(['personal','sensitive']),
 scope:z.enum(['space','background']),authority_hash:z.string(),tools:z.array(pin),default_expires_in_seconds:z.number().int().positive().nullable(),
 active_grant_id:IdSchema.nullable(),changes:diff.nullable(),
}).strict();
/**
 * `authority_hash` is the identity of the option the person confirmed, never a
 * tool list: the server refuses the write when the composed package differs.
 */
const create=z.object({
 plugin_id:z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),toolset:z.enum(['read','write']),data_class:z.enum(['personal','sensitive']),
 scope:z.enum(['space','run','background']),target_run_id:IdSchema.optional(),
 expires_in_seconds:z.number().int().min(60).max(86_400).optional(),
 authority_hash:z.string().min(1).max(64),
}).strict();
const read=z.object({
 id:IdSchema,run_id:IdSchema,agent_id:IdSchema.nullable(),action_id:z.string(),resource_type:z.string(),
 resource_ids:z.array(z.string()),data_class:z.enum(['non_sensitive','personal','sensitive']),grant_id:IdSchema.nullable(),accessed_at:ISODateTimeSchema,
}).strict();
export const PLUGIN_DATA_ACCESS_OPERATION_SCHEMAS={
 'plugin_data_grant.create':{input:create,output:grant},
 'plugin_data_grant.revoke':{input:z.object({grant_id:IdSchema}).strict(),output:grant},
 'plugin_data_grant.revoke_run':{input:z.object({run_id:IdSchema}).strict(),output:z.object({run_id:IdSchema,revoked_grant_ids:z.array(IdSchema)}).strict()},
 'plugin_data_grant.list':{input:z.object({plugin_id:z.string().max(24).optional(),status:z.enum(['active','revoked','expired']).optional(),run_id:IdSchema.optional()}).strict(),output:z.object({items:z.array(grant),
  /** Present without `run_id`: what this person may consent to now; an option is never a grant. */
  consentable:z.array(option).optional()}).strict()},
 'agent_data_read.list':{input:z.object({run_id:IdSchema.optional(),limit:z.number().int().min(1).max(200).default(50)}).strict(),output:z.object({items:z.array(read),has_more:z.boolean()}).strict()},
} as const;
export type PluginDataGrant=z.infer<typeof grant>;
export type PluginDataConsentOption=z.infer<typeof option>;
export type AgentDataRead=z.infer<typeof read>;
