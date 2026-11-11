import {pgTable,varchar,jsonb,timestamp,index,uniqueIndex,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {spaces} from './spaces.js';
import {users} from './auth.js';

/**
 * A person's durable system settings / tool configuration command whose
 * effect is vendor, filesystem or network IO (`.agent/architecture/SYSTEM_ACTIONS.md`
 * "System settings and tool configuration commands"). The operation
 * transaction commits this intent and its Job; the worker performs the effect
 * outside every transaction and records its outcome here.
 * `effect_json.dispatched_at` is written before the effect starts, so a worker
 * that finds it without an outcome knows the effect may have happened. At most
 * one active command per scope (`scope_key`). `needs_attention` is an outcome
 * the control plane cannot prove; it never reads as success. No secret is ever
 * frozen here: credentials stay in the encrypted credential channel.
 */
export const systemCommandIntents=pgTable('system_command_intents',{
  id:varchar({length:36}).primaryKey().notNull(),
  spaceId:varchar('space_id',{length:36}).notNull(),
  userId:varchar('user_id',{length:36}).notNull(),
  kind:varchar({length:48}).notNull(),
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
  index('ix_system_command_owner').on(table.spaceId,table.userId,table.createdAt),
  uniqueIndex('uq_system_command_active_scope').on(table.scopeKey).where(sql`status IN ('pending','dispatched')`),
  foreignKey({columns:[table.spaceId],foreignColumns:[spaces.id]}),
  foreignKey({columns:[table.userId],foreignColumns:[users.id]}),
  check('ck_system_command_kind',sql`kind IN ('provider_test','provider_plan_usage_refresh','provider_subscription_quota_refresh','plugin_install','backup_manual','webhook_dispatch')`),
  check('ck_system_command_status',sql`status IN ('pending','dispatched','succeeded','failed','needs_attention')`),
]);
