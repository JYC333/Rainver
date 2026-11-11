import {pgTable,varchar,jsonb,timestamp,index,uniqueIndex,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {spaces} from './spaces.js';
import {users} from './auth.js';
import {hosts} from './hosts.js';

/**
 * A person's durable command to a Host (`.agent/modules/hosts.md` "Host
 * commands"). The operation transaction commits this intent and its Job; the
 * worker performs the Host effect outside every transaction and records its
 * outcome here. `effect_json.dispatched_at` is written before a frame leaves,
 * so a worker that finds it without an outcome knows the effect may have run.
 * At most one active command per Host scope (`scope_key`). `needs_attention`
 * is an outcome the control plane cannot prove; it never reads as success.
 */
export const hostCommandIntents=pgTable('host_command_intents',{
  id:varchar({length:36}).primaryKey().notNull(),
  spaceId:varchar('space_id',{length:36}).notNull(),
  hostId:varchar('host_id',{length:36}).notNull(),
  userId:varchar('user_id',{length:36}).notNull(),
  agentId:varchar('agent_id',{length:36}),
  kind:varchar({length:32}).notNull(),
  scopeKey:varchar('scope_key',{length:64}).notNull(),
  status:varchar({length:24}).notNull(),
  jobId:varchar('job_id',{length:36}),
  frozenJson:jsonb('frozen_json').notNull(),
  effectJson:jsonb('effect_json').notNull(),
  resultJson:jsonb('result_json'),
  errorCode:varchar('error_code',{length:120}),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  index('ix_host_command_owner').on(table.spaceId,table.userId,table.hostId,table.createdAt),
  uniqueIndex('uq_host_command_active_scope').on(table.hostId,table.scopeKey).where(sql`status IN ('pending','dispatched')`),
  index('ix_host_command_agent_fence').on(table.hostId,table.agentId).where(sql`kind = 'agent_host_state_reset' AND status IN ('pending','dispatched')`),
  foreignKey({columns:[table.spaceId],foreignColumns:[spaces.id]}),
  foreignKey({columns:[table.hostId],foreignColumns:[hosts.id]}).onDelete('cascade'),
  foreignKey({columns:[table.userId],foreignColumns:[users.id]}),
  check('ck_host_command_kind',sql`kind IN ('workspace_register','runtime_install','runtime_uninstall','runtime_own_update','runtime_managed_update','runtime_rollback','runtime_usage_refresh','ordinary_tool_install','ordinary_tool_register','ordinary_tool_remove','ordinary_account_logout','agent_host_state_reset','ambient_sync')`),
  check('ck_host_command_status',sql`status IN ('pending','dispatched','succeeded','failed','needs_attention')`),
]);
