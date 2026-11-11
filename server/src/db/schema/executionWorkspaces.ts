import {pgTable,varchar,integer,jsonb,timestamp,index,uniqueIndex,unique,check,foreignKey,primaryKey,type PgTableExtraConfigValue} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {spaces} from './spaces.js';
import {projects} from './projects.js';
import {workspaceLocations} from './workspaceLocations.js';
import {sessions} from './sessions.js';
import {tasks} from './tasks.js';
import {runDelegations} from './agentGroups.js';

export const executionWorkspaces=pgTable('execution_workspaces',{
 id:varchar({length:36}).primaryKey(),spaceId:varchar('space_id',{length:36}).notNull(),projectId:varchar('project_id',{length:36}).notNull(),
 workspaceLocationId:varchar('workspace_location_id',{length:36}).notNull(),executionHostId:varchar('execution_host_id',{length:36}).notNull(),
 ownerKind:varchar('owner_kind',{length:20}).notNull(),sessionId:varchar('session_id',{length:36}),taskId:varchar('task_id',{length:36}),delegationId:varchar('delegation_id',{length:36}),
 parentWorkspaceId:varchar('parent_workspace_id',{length:36}),generation:integer().notNull().default(1),revision:integer().notNull().default(1),
 headSequence:integer('head_sequence').notNull().default(0),
 baselineMode:varchar('baseline_mode',{length:16}),snapshotHead:varchar('snapshot_head',{length:64}),
 state:varchar({length:24}).notNull().default('requested'),baseCommit:varchar('base_commit',{length:64}),baseTree:varchar('base_tree',{length:64}),headCommit:varchar('head_commit',{length:64}),targetRef:varchar('target_ref',{length:256}),
 inventoryJson:jsonb('inventory_json').notNull().default({}),
 cleanupState:varchar('cleanup_state',{length:24}).notNull().default('pending'),cleanupJson:jsonb('cleanup_json').notNull().default({}),
 // Raised before a branch-releasing cleanup is issued; launches carry it so an
 // older cleanup cannot remove a rebuilt materialization of the same identity.
 materializationEpoch:integer('materialization_epoch').notNull().default(0),
 // Latest visible retention assessment, user hold and reclaim facts.
 retentionJson:jsonb('retention_json').notNull().default({}),
 createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>[
 unique('uq_execution_workspaces_id_space').on(t.id,t.spaceId),
 uniqueIndex('uq_execution_workspaces_session').on(t.sessionId,t.workspaceLocationId,t.generation).where(sql`owner_kind='conversation'`),
 uniqueIndex('uq_execution_workspaces_task').on(t.taskId,t.workspaceLocationId,t.generation).where(sql`owner_kind='task'`),
 uniqueIndex('uq_execution_workspaces_delegation').on(t.delegationId,t.workspaceLocationId,t.generation).where(sql`owner_kind='delegation'`),
 foreignKey({columns:[t.spaceId],foreignColumns:[spaces.id]}),
 foreignKey({columns:[t.projectId,t.spaceId],foreignColumns:[projects.id,projects.spaceId]}),
 foreignKey({columns:[t.workspaceLocationId,t.executionHostId],foreignColumns:[workspaceLocations.id,workspaceLocations.executionHostId]}),
 foreignKey({columns:[t.sessionId,t.spaceId],foreignColumns:[sessions.id,sessions.spaceId]}),
 foreignKey({columns:[t.taskId,t.spaceId],foreignColumns:[tasks.id,tasks.spaceId]}),
 foreignKey({columns:[t.delegationId,t.spaceId],foreignColumns:[runDelegations.id,runDelegations.spaceId]}),
 check('ck_execution_workspace_owner',sql`(owner_kind='conversation' AND session_id IS NOT NULL AND task_id IS NULL AND delegation_id IS NULL) OR (owner_kind='task' AND task_id IS NOT NULL AND session_id IS NULL AND delegation_id IS NULL) OR (owner_kind='delegation' AND delegation_id IS NOT NULL AND session_id IS NULL AND task_id IS NULL)`),
 check('ck_execution_workspace_versions',sql`generation>0 AND revision>0 AND materialization_epoch>=0`),
 check('ck_execution_workspace_state',sql`state IN ('requested','preparing','ready','blocked','retiring','retired')`),
 check('ck_execution_workspace_cleanup',sql`cleanup_state IN ('pending','running','retry_wait','blocked','cleaned')`),
] satisfies PgTableExtraConfigValue[]);
export const workspaceChangeSets=pgTable('workspace_change_sets',{
 id:varchar({length:36}).primaryKey(),workspaceId:varchar('workspace_id',{length:36}).notNull(),spaceId:varchar('space_id',{length:36}).notNull(),
 generation:integer().notNull(),sequence:integer().notNull(),revision:integer().notNull().default(1),state:varchar({length:24}).notNull().default('open'),
 originatingRunId:varchar('originating_run_id',{length:36}).notNull(),rootRunId:varchar('root_run_id',{length:36}).notNull(),
 baseCommit:varchar('base_commit',{length:64}),sourceCommit:varchar('source_commit',{length:64}),completionBasis:varchar('completion_basis',{length:256}),summary:varchar({length:16000}),
 sourceSequence:integer('source_sequence').notNull().default(0),
 verificationJson:jsonb('verification_json').notNull().default({}),
 createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>[
 foreignKey({columns:[t.workspaceId,t.spaceId],foreignColumns:[executionWorkspaces.id,executionWorkspaces.spaceId]}),
 unique('uq_workspace_change_sequence').on(t.workspaceId,t.generation,t.sequence),unique('uq_workspace_changes_id_space').on(t.id,t.spaceId),
 uniqueIndex('uq_workspace_change_open').on(t.workspaceId).where(sql`state='open'`),
 check('ck_workspace_changes_state',sql`state IN ('open','ready','integrating','blocked','integrated','no_changes','abandoned')`),
 check('ck_workspace_changes_version',sql`generation>0 AND sequence>0 AND revision>0`),
 index('ix_workspace_changes_run').on(t.spaceId,t.originatingRunId),
] satisfies PgTableExtraConfigValue[]);

import {runs} from './runs.js';
export const executionWorkspaceRuns=pgTable('execution_workspace_runs',{
 runId:varchar('run_id',{length:36}).notNull(),workspaceId:varchar('workspace_id',{length:36}).notNull(),spaceId:varchar('space_id',{length:36}).notNull(),changeSetId:varchar('change_set_id',{length:36}).notNull(),
 accessMode:varchar('access_mode',{length:8}).notNull().default('write'),
 launchSequence:integer('launch_sequence').notNull().default(0),
 launchReferenceJson:jsonb('launch_reference_json'),
 startCommit:varchar('start_commit',{length:64}),checkpointCommit:varchar('checkpoint_commit',{length:64}),checkpointState:varchar('checkpoint_state',{length:24}).notNull().default('pending'),
 createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>[
 unique('uq_workspace_run_binding').on(t.runId,t.workspaceId),
 foreignKey({columns:[t.runId,t.spaceId],foreignColumns:[runs.id,runs.spaceId]}),
 foreignKey({columns:[t.workspaceId,t.spaceId],foreignColumns:[executionWorkspaces.id,executionWorkspaces.spaceId]}),
 foreignKey({columns:[t.changeSetId,t.spaceId],foreignColumns:[workspaceChangeSets.id,workspaceChangeSets.spaceId]}),
 check('ck_workspace_run_access',sql`access_mode IN ('read','write')`),
 check('ck_workspace_run_checkpoint',sql`checkpoint_state IN ('pending','saved','blocked')`),
] satisfies PgTableExtraConfigValue[]);

/**
 * The frozen basis of a read-only delegated review of its coordinator's
 * workspace (ADR 0029, "Delegated workspace placement"): written once when the
 * review is first placed and reused verbatim by every replay of the same Run,
 * so a retry can neither re-place it (a fork, another version) nor move the
 * expected commit. It is no batch and no binding: it never creates a change
 * set, checkpoint or saved result. `expected_commit` is what the server froze;
 * `observed_commit`/`observed_tree` are what the Host reported reading after it
 * verified that clean version under its shared lease. Only `verified` means the
 * review actually ran on the expected version; `refused` records the Host's
 * refusal code.
 */
export const executionWorkspaceReviews=pgTable('execution_workspace_reviews',{
 runId:varchar('run_id',{length:36}).primaryKey(),spaceId:varchar('space_id',{length:36}).notNull(),
 workspaceId:varchar('workspace_id',{length:36}).notNull(),generation:integer().notNull(),
 workspaceLocationId:varchar('workspace_location_id',{length:36}).notNull(),
 expectedCommit:varchar('expected_commit',{length:64}).notNull(),
 state:varchar({length:16}).notNull().default('pending'),
 observedCommit:varchar('observed_commit',{length:64}),observedTree:varchar('observed_tree',{length:64}),
 refusal:varchar({length:64}),
 createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
 observedAt:timestamp('observed_at',{withTimezone:true,mode:'string'}),
},t=>[
 foreignKey({columns:[t.runId,t.spaceId],foreignColumns:[runs.id,runs.spaceId]}),
 foreignKey({columns:[t.workspaceId,t.spaceId],foreignColumns:[executionWorkspaces.id,executionWorkspaces.spaceId]}),
 check('ck_workspace_review_state',sql`state IN ('pending','verified','refused')`),
 index('ix_workspace_reviews_workspace').on(t.spaceId,t.workspaceId),
] satisfies PgTableExtraConfigValue[]);

/**
 * Durable deletion intents for shared `refs/rainver/sources/<commit>` refs:
 * one row per (Host, commit, unended Host operation). A ref release inserts the
 * rows of its batch in the claim transaction, under the per-(Host, commit)
 * advisory lock, after proving no dependent exists; only the proven end of that
 * same operation (its confirmation, or a settle that cancelled it for good)
 * deletes its rows. Several rows for one commit exist only for operations
 * claimed before this fence (each kept until it ended). While any row exists,
 * the `workspace_source_release_fence` trigger refuses every new dependent
 * (`workspace_source_dependent_commits`) of that commit on that Host.
 */
export const workspaceSourceReleases=pgTable('workspace_source_releases',{
 hostId:varchar('host_id',{length:36}).notNull(),commit:varchar({length:64}).notNull(),
 workspaceId:varchar('workspace_id',{length:36}).notNull(),generation:integer().notNull(),
 operationId:varchar('operation_id',{length:36}).notNull(),
 createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>[
 primaryKey({columns:[t.hostId,t.commit,t.operationId]}),
 index('ix_workspace_source_releases_operation').on(t.operationId),
] satisfies PgTableExtraConfigValue[]);
