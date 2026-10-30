import {pgTable,varchar,integer,jsonb,timestamp,text,unique,foreignKey,index,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {spaces} from './spaces.js';
import {users} from './auth.js';
import {projects} from './projects.js';
import {sourceConnections,sourceItems} from './sources.js';
const id=()=>varchar({length:36}).primaryKey();
const at=(name:string)=>timestamp(name,{withTimezone:true,mode:'string'}).notNull().defaultNow();
export const sourceGoals=pgTable('source_goals',{
 id:id(),spaceId:varchar('space_id',{length:36}).notNull().references(()=>spaces.id),
 ownerUserId:varchar('owner_user_id',{length:36}).notNull().references(()=>users.id),projectId:varchar('project_id',{length:36}),
 agentId:varchar('agent_id',{length:36}),runtimeProfileId:varchar('runtime_profile_id',{length:36}),
 creationKey:varchar('creation_key',{length:128}),sessionId:varchar('session_id',{length:36}),legacyChannelId:varchar('legacy_channel_id',{length:36}),compatibilityJson:jsonb('compatibility_json'),
 intentJson:jsonb('intent_json').notNull(),budgetJson:jsonb('budget_json').notNull(),
 /** Owner's confirmed continuous-following intent and authorized scope; null until confirmed. */
 followJson:jsonb('follow_json'),status:varchar({length:32}).notNull().default('draft'),
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
/** Server-recorded Goal ↔ SourceItem membership. Written only by the goal
 * materializer from the actual goal/version/binding/collection, never from
 * model-supplied metadata. One SourceItem may belong to many goals. */
export const sourceGoalItems=pgTable('source_goal_items',{
 id:id(),spaceId:varchar('space_id',{length:36}).notNull(),goalId:varchar('goal_id',{length:36}).notNull(),sourceItemId:varchar('source_item_id',{length:36}).notNull(),
 sourceConnectionId:varchar('source_connection_id',{length:36}).notNull(),bindingId:varchar('binding_id',{length:36}).notNull(),versionId:varchar('version_id',{length:36}).notNull(),
 firstGoalRunId:varchar('first_goal_run_id',{length:36}).notNull(),lastGoalRunId:varchar('last_goal_run_id',{length:36}).notNull(),agentRunId:varchar('agent_run_id',{length:36}),
 selectionStatus:varchar('selection_status',{length:24}).notNull().default('unjudged'),selectionReason:text('selection_reason'),selectionSource:varchar('selection_source',{length:24}).notNull().default('collection'),
 /** Who judged the selection, when; the evidence URL of a claimed change. */
 judgedBy:varchar('judged_by',{length:24}),judgedAt:timestamp('judged_at',{withTimezone:true,mode:'string'}),changeEvidenceUrl:text('change_evidence_url'),
 /** First-collection background, newer publication, evidenced change, or unknown freshness (never inferred from observation time). */
 deliveryKind:varchar('delivery_kind',{length:24}).notNull().default('unknown_freshness'),
 associatedAt:at('associated_at'),updatedAt:at('updated_at'),
},t=>[unique('uq_source_goal_items_goal_item').on(t.goalId,t.sourceItemId),index('ix_source_goal_items_item').on(t.spaceId,t.sourceItemId),index('ix_source_goal_items_goal_run').on(t.goalId,t.firstGoalRunId),
 foreignKey({columns:[t.spaceId,t.goalId],foreignColumns:[sourceGoals.spaceId,sourceGoals.id]}),foreignKey({columns:[t.sourceItemId,t.spaceId],foreignColumns:[sourceItems.id,sourceItems.spaceId]}),
 check('ck_source_goal_items_selection',sql`${t.selectionStatus} IN ('unjudged','important','not_selected','judgment_failed')`),check('ck_source_goal_items_selection_source',sql`${t.selectionSource} IN ('collection','topic_judgment','owner_feedback')`),
 check('ck_source_goal_items_judged_by',sql`${t.judgedBy} IS NULL OR ${t.judgedBy} IN ('topic_rules','collection_agent','owner')`),check('ck_source_goal_items_delivery',sql`${t.deliveryKind} IN ('baseline','new_publication','evidenced_change','unknown_freshness')`)]);
/** Per-topic history of cited changes to an already stable material. One row
 * per goal, item and evidence URL, so the same evidence is delivered once and a
 * later, different change is recorded again. Written only by the goal
 * materializer from the collection that reported it; never rewrites content. */
export const sourceGoalItemChanges=pgTable('source_goal_item_changes',{
 id:id(),spaceId:varchar('space_id',{length:36}).notNull(),goalId:varchar('goal_id',{length:36}).notNull(),sourceItemId:varchar('source_item_id',{length:36}).notNull(),
 changeKind:varchar('change_kind',{length:24}).notNull(),evidenceUrl:text('evidence_url').notNull(),
 deliveryKind:varchar('delivery_kind',{length:24}).notNull(),goalRunId:varchar('goal_run_id',{length:36}).notNull(),agentRunId:varchar('agent_run_id',{length:36}),
 bindingId:varchar('binding_id',{length:36}).notNull(),versionId:varchar('version_id',{length:36}).notNull(),
 selectionStatus:varchar('selection_status',{length:24}).notNull().default('unjudged'),selectionReason:text('selection_reason'),judgedBy:varchar('judged_by',{length:24}),
 detectedAt:at('detected_at'),
 /** Only subsequent changes are separate deliveries; initial material is delivered by membership. */
 deliveredAt:timestamp('delivered_at',{withTimezone:true,mode:'string'}),
},t=>[unique('uq_source_goal_item_changes_space_id').on(t.spaceId,t.id),unique('uq_source_goal_item_changes_evidence').on(t.goalId,t.sourceItemId,t.evidenceUrl),index('ix_source_goal_item_changes_goal').on(t.goalId,t.detectedAt),
 foreignKey({columns:[t.goalId,t.sourceItemId],foreignColumns:[sourceGoalItems.goalId,sourceGoalItems.sourceItemId]}),foreignKey({columns:[t.spaceId,t.goalId],foreignColumns:[sourceGoals.spaceId,sourceGoals.id]}),
 check('ck_source_goal_item_changes_kind',sql`${t.changeKind} IN ('release','update')`),check('ck_source_goal_item_changes_delivery',sql`${t.deliveryKind} IN ('baseline','evidenced_change')`),
 check('ck_source_goal_item_changes_selection',sql`${t.selectionStatus} IN ('unjudged','important','not_selected','judgment_failed')`),
 check('ck_source_goal_item_changes_judged_by',sql`${t.judgedBy} IS NULL OR ${t.judgedBy} IN ('topic_rules','collection_agent','owner')`)]);

/** Per-user acknowledgement of one immutable, per-topic change delivery.
 * This never changes the SourceItem's body revision, annotations or reading state. */
export const sourceGoalChangeUserStates=pgTable('source_goal_change_user_states',{
 spaceId:varchar('space_id',{length:36}).notNull(),changeId:varchar('change_id',{length:36}).notNull(),userId:varchar('user_id',{length:36}).notNull().references(()=>users.id),
 readStatus:varchar('read_status',{length:24}).notNull().default('unread'),dismissed:integer('dismissed').notNull().default(0),updatedAt:at('updated_at'),
},t=>[unique('uq_source_goal_change_user').on(t.changeId,t.userId),foreignKey({columns:[t.spaceId,t.changeId],foreignColumns:[sourceGoalItemChanges.spaceId,sourceGoalItemChanges.id]}),check('ck_source_goal_change_read',sql`${t.readStatus} IN ('unread','skimmed','read','discussed')`),check('ck_source_goal_change_dismissed',sql`${t.dismissed} IN (0,1)`)]);
