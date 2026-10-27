import {pgTable,varchar,integer,jsonb,timestamp,unique,foreignKey,index,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {spaces} from './spaces.js';
import {users} from './auth.js';
import {projects} from './projects.js';
import {sourceConnections} from './sources.js';
const id=()=>varchar({length:36}).primaryKey();
const at=(name:string)=>timestamp(name,{withTimezone:true,mode:'string'}).notNull().defaultNow();
export const sourceGoals=pgTable('source_goals',{
 id:id(),spaceId:varchar('space_id',{length:36}).notNull().references(()=>spaces.id),
 ownerUserId:varchar('owner_user_id',{length:36}).notNull().references(()=>users.id),projectId:varchar('project_id',{length:36}),
 agentId:varchar('agent_id',{length:36}),runtimeProfileId:varchar('runtime_profile_id',{length:36}),
 creationKey:varchar('creation_key',{length:128}),sessionId:varchar('session_id',{length:36}),legacyChannelId:varchar('legacy_channel_id',{length:36}),compatibilityJson:jsonb('compatibility_json'),
 intentJson:jsonb('intent_json').notNull(),budgetJson:jsonb('budget_json').notNull(),status:varchar({length:32}).notNull().default('draft'),
 revision:integer().notNull().default(0),currentVersionId:varchar('current_version_id',{length:36}),activeVersionId:varchar('active_version_id',{length:36}),
 startKey:varchar('start_key',{length:128}),adjustmentCycle:integer('adjustment_cycle').notNull().default(0),agentAttempts:integer('agent_attempts').notNull().default(0),createdAt:at('created_at'),updatedAt:at('updated_at'),
},t=>[unique('uq_source_goals_space_id').on(t.spaceId,t.id),unique('uq_source_goal_creation').on(t.spaceId,t.ownerUserId,t.creationKey),unique('uq_source_goals_legacy_channel').on(t.spaceId,t.legacyChannelId),foreignKey({columns:[t.spaceId,t.projectId],foreignColumns:[projects.spaceId,projects.id]}),check('ck_source_goal_revision',sql`${t.revision}>=0`)]);
export const sourceGoalVersions=pgTable('source_goal_versions',{
 id:id(),spaceId:varchar('space_id',{length:36}).notNull(),goalId:varchar('goal_id',{length:36}).notNull(),revision:integer().notNull(),
 adjustmentCycle:integer('adjustment_cycle').notNull().default(0),planJson:jsonb('plan_json').notNull(),createdByRunId:varchar('created_by_run_id',{length:36}).notNull(),createdAt:at('created_at'),
},t=>[unique('uq_source_goal_versions_revision').on(t.goalId,t.revision),unique('uq_source_goal_versions_space_id').on(t.spaceId,t.id),foreignKey({columns:[t.spaceId,t.goalId],foreignColumns:[sourceGoals.spaceId,sourceGoals.id]})]);
export const sourceGoalPreviews=pgTable('source_goal_previews',{
 id:id(),spaceId:varchar('space_id',{length:36}).notNull(),goalId:varchar('goal_id',{length:36}).notNull(),versionId:varchar('version_id',{length:36}).notNull(),
 status:varchar({length:24}).notNull(),resultJson:jsonb('result_json').notNull(),expiresAt:at('expires_at'),createdAt:at('created_at'),
},t=>[foreignKey({columns:[t.spaceId,t.goalId],foreignColumns:[sourceGoals.spaceId,sourceGoals.id]}),foreignKey({columns:[t.spaceId,t.versionId],foreignColumns:[sourceGoalVersions.spaceId,sourceGoalVersions.id]})]);
export const sourceGoalBindings=pgTable('source_goal_bindings',{
 id:id(),spaceId:varchar('space_id',{length:36}).notNull(),goalId:varchar('goal_id',{length:36}).notNull(),connectionId:varchar('source_connection_id',{length:36}).notNull(),
 specJson:jsonb('spec_json').notNull(),previousSpecJson:jsonb('previous_spec_json'),revision:integer().notNull().default(0),status:varchar({length:32}).notNull().default('active'),
 cursorJson:jsonb('cursor_json').notNull().default({}),gapsJson:jsonb('gaps_json').notNull().default([]),fixtureJson:jsonb('fixture_json'),
 failures:integer().notNull().default(0),repairAttempts:integer('repair_attempts').notNull().default(0),retryAt:timestamp('retry_at',{withTimezone:true,mode:'string'}),
 leaseToken:varchar('lease_token',{length:36}),leaseUntil:timestamp('lease_until',{withTimezone:true,mode:'string'}),lastSuccessAt:timestamp('last_success_at',{withTimezone:true,mode:'string'}),
 updatedAt:at('updated_at'),
},t=>[unique('uq_source_goal_bindings_source').on(t.goalId,t.connectionId),unique('uq_source_goal_bindings_space_id').on(t.spaceId,t.id),foreignKey({columns:[t.spaceId,t.goalId],foreignColumns:[sourceGoals.spaceId,sourceGoals.id]}),foreignKey({columns:[t.connectionId,t.spaceId],foreignColumns:[sourceConnections.id,sourceConnections.spaceId]})]);
export const sourceGoalRepairs=pgTable('source_goal_repairs',{
 id:id(),spaceId:varchar('space_id',{length:36}).notNull(),bindingId:varchar('binding_id',{length:36}).notNull(),baseRevision:integer('base_revision').notNull(),
 candidateJson:jsonb('candidate_json').notNull(),validationJson:jsonb('validation_json'),status:varchar({length:24}).notNull().default('candidate'),createdByRunId:varchar('created_by_run_id',{length:36}).notNull(),createdAt:at('created_at'),
},t=>[unique('uq_source_goal_repair_run_revision').on(t.bindingId,t.createdByRunId,t.baseRevision),foreignKey({columns:[t.spaceId,t.bindingId],foreignColumns:[sourceGoalBindings.spaceId,sourceGoalBindings.id]})]);
export const sourceGoalRuns=pgTable('source_goal_runs',{
 id:id(),spaceId:varchar('space_id',{length:36}).notNull(),goalId:varchar('goal_id',{length:36}).notNull(),bindingId:varchar('binding_id',{length:36}),versionId:varchar('version_id',{length:36}).notNull(),
 status:varchar({length:24}).notNull(),resultJson:jsonb('result_json'),startedAt:at('started_at'),endedAt:timestamp('ended_at',{withTimezone:true,mode:'string'}),
},t=>[index('ix_source_goal_runs_goal').on(t.goalId,t.startedAt),foreignKey({columns:[t.spaceId,t.goalId],foreignColumns:[sourceGoals.spaceId,sourceGoals.id]})]);
