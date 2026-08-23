import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, boolean, doublePrecision, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actors, agentRuntimeProfiles, agentVersions, agents } from "./agents";
import { users } from "./auth";
import { sessions } from "./sessions";
import { spaces } from "./spaces";
import { projectFolders } from "./projectFolders";
import { hostTaskThreads } from "./hostTaskThreads";
import { modelProviders } from "./providers";
import { agentRunGroups, runDelegations } from "./agentGroups";
import { artifacts } from "./artifacts";
import { proposals } from "./proposals";
import { projects } from "./projects";
import { tasks } from "./tasks";
import { jobs } from "./jobs";
import { evolvableAssetVersions } from "./evolvableAssets";

export const runs = pgTable("runs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	agentVersionId: varchar("agent_version_id", { length: 36 }).notNull(),
	runRole: varchar("run_role", { length: 32 }).default('execution').notNull(),
	requestedRuntimeProfileId: varchar("requested_runtime_profile_id", { length: 36 }),
	selectedRuntimeProfileId: varchar("runtime_profile_id", { length: 36 }),
	runtimeProfileSelectionSource: varchar("runtime_profile_selection_source", { length: 16 }),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	// ADR 0016 D14: set only for a run dispatched into a host task thread
	// (remote-host runs); null for every server-host run.
	hostTaskThreadId: varchar("host_task_thread_id", { length: 36 }),
	sessionId: varchar("session_id", { length: 36 }),
	parentRunId: varchar("parent_run_id", { length: 36 }),
	rootRunId: varchar("root_run_id", { length: 36 }),
	runGroupId: varchar("run_group_id", { length: 36 }),
	delegationId: varchar("delegation_id", { length: 36 }),
	instructedBy: varchar("instructed_by", { length: 128 }),
	instructedByUserId: varchar("instructed_by_user_id", { length: 36 }),
	instructedByAgentId: varchar("instructed_by_agent_id", { length: 36 }),
	runType: varchar("run_type", { length: 32 }).notNull(),
	triggerOrigin: varchar("trigger_origin", { length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	mode: varchar({ length: 32 }).notNull(),
	prompt: text(),
	instruction: text(),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	selectedModelProviderId: varchar("model_provider_id", { length: 36 }),
	errorMessage: text("error_message"),
	errorJson: jsonb("error_json"),
	outputJson: jsonb("output_json"),
	selectedAdapterType: varchar("adapter_type", { length: 64 }),
	capabilityId: varchar("capability_id", { length: 128 }),
	capabilitiesJson: jsonb("capabilities_json").default([]).notNull(),
	modelSelectionMode: varchar("model_selection_mode", { length: 32 }).default('cli_default').notNull(),
	modelOverrideJson: jsonb("model_override_json"),
	runtimeProfileSnapshotJson: jsonb("runtime_profile_snapshot_json"),
	permissionSnapshotJson: jsonb("permission_snapshot_json"),
	requiredSandboxLevel: varchar("required_sandbox_level", { length: 32 }).default('none').notNull(),
	sandboxPath: text("sandbox_path"),
	runtimeSeconds: doublePrecision("runtime_seconds"),
	exitCode: integer("exit_code"),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	visibility: varchar({ length: 32 }).default('space_shared').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	hasContextTaint: boolean("has_context_taint").default(false).notNull(),
	contextTaintJson: jsonb("context_taint_json"),
	source: varchar({ length: 32 }),
	observabilityLevel: varchar("observability_level", { length: 64 }),
	dataExposureLevel: varchar("data_exposure_level", { length: 64 }),
	trustLevel: varchar("trust_level", { length: 32 }),
	externalityLevel: varchar("externality_level", { length: 32 }),
	projectId: varchar("project_id", { length: 36 }),
	contractSnapshotJson: jsonb("contract_snapshot_json").default({}).notNull(),
	workflowVersionId: varchar("workflow_version_id", { length: 36 }),
	activeRouteDecisionId: varchar("route_decision_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_runs_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_runs_agent_version_id").using("btree", table.agentVersionId.asc().nullsLast()),
	index("ix_runs_delegation_id").using("btree", table.spaceId.asc().nullsLast(), table.delegationId.asc().nullsLast()),
	index("ix_runs_group_id").using("btree", table.spaceId.asc().nullsLast(), table.runGroupId.asc().nullsLast()),
	index("ix_runs_instructed_by_agent_id").using("btree", table.spaceId.asc().nullsLast(), table.instructedByAgentId.asc().nullsLast()),
	index("ix_runs_instructed_by_user_id").using("btree", table.instructedByUserId.asc().nullsLast()),
	index("ix_runs_mode").using("btree", table.mode.asc().nullsLast()),
	index("ix_runs_model_provider_id").using("btree", table.selectedModelProviderId.asc().nullsLast()),
	index("ix_runs_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_runs_parent_run_id").using("btree", table.parentRunId.asc().nullsLast()),
	index("ix_runs_parent_run_space").using("btree", table.spaceId.asc().nullsLast(), table.parentRunId.asc().nullsLast()),
	index("ix_runs_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_runs_root_run_id").using("btree", table.spaceId.asc().nullsLast(), table.rootRunId.asc().nullsLast()),
	index("ix_runs_run_type").using("btree", table.runType.asc().nullsLast()),
	index("ix_runs_requested_runtime_profile_id").using("btree", table.requestedRuntimeProfileId.asc().nullsLast()),
	index("ix_runs_runtime_profile_id").using("btree", table.selectedRuntimeProfileId.asc().nullsLast()),
	index("ix_runs_route_decision_id").using("btree", table.activeRouteDecisionId.asc().nullsLast()),
	index("ix_runs_session_id").using("btree", table.sessionId.asc().nullsLast()),
	index("ix_runs_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_runs_status").using("btree", table.status.asc().nullsLast()),
	index("ix_runs_trigger_origin").using("btree", table.triggerOrigin.asc().nullsLast()),
	index("ix_runs_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	index("ix_runs_host_task_thread_id").using("btree", table.hostTaskThreadId.asc().nullsLast()),
	foreignKey({ columns: [table.workflowVersionId], foreignColumns: [evolvableAssetVersions.id], name: "runs_workflow_version_fkey" }),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "runs_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "runs_project_id_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "fk_runs_project_id_projects"
		}),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "runs_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.agentVersionId, table.agentId, table.spaceId],
			foreignColumns: [agentVersions.id, agentVersions.agentId, agentVersions.spaceId],
			name: "runs_agent_version_id_fkey"
		}),
	foreignKey({
			columns: [table.delegationId],
			foreignColumns: [runDelegations.id],
			name: "runs_delegation_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.hostTaskThreadId],
			foreignColumns: [hostTaskThreads.id],
			name: "runs_host_task_thread_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.instructedByAgentId],
			foreignColumns: [agents.id],
			name: "runs_instructed_by_agent_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.instructedByUserId],
			foreignColumns: [users.id],
			name: "runs_instructed_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.selectedModelProviderId],
			foreignColumns: [modelProviders.id],
			name: "runs_model_provider_id_fkey"
		}),
	foreignKey({
			columns: [table.selectedRuntimeProfileId],
			foreignColumns: [agentRuntimeProfiles.id],
			name: "runs_selected_runtime_profile_id_fkey"
		}),
	foreignKey({
			columns: [table.requestedRuntimeProfileId],
			foreignColumns: [agentRuntimeProfiles.id],
			name: "runs_requested_runtime_profile_id_fkey"
		}),
	foreignKey({
			columns: [table.parentRunId],
			foreignColumns: [table.id],
			name: "runs_parent_run_id_fkey"
		}),
	foreignKey({
			columns: [table.rootRunId],
			foreignColumns: [table.id],
			name: "runs_root_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.runGroupId],
			foreignColumns: [agentRunGroups.id],
			name: "runs_run_group_id_fkey"
		}),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [sessions.id],
			name: "runs_session_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "runs_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "runs_project_folder_id_fkey"
		}),
	foreignKey({
			columns: [table.delegationId, table.spaceId],
			foreignColumns: [runDelegations.id, runDelegations.spaceId],
			name: "fk_runs_delegation_same_space"
		}),
	foreignKey({
			columns: [table.instructedByAgentId, table.spaceId],
			foreignColumns: [agents.id, agents.spaceId],
			name: "fk_runs_instructed_by_agent_same_space"
		}),
	foreignKey({
			columns: [table.parentRunId, table.spaceId],
			foreignColumns: [table.id, table.spaceId],
			name: "fk_runs_parent_run_same_space"
		}),
	foreignKey({
			columns: [table.rootRunId, table.spaceId],
			foreignColumns: [table.id, table.spaceId],
			name: "fk_runs_root_run_same_space"
		}),
	foreignKey({
			columns: [
				table.runGroupId,
				table.spaceId,
				table.sessionId,
				table.projectId,
			],
			foreignColumns: [
				agentRunGroups.id,
				agentRunGroups.spaceId,
				agentRunGroups.sessionId,
				agentRunGroups.projectId,
			],
			name: "runs_run_group_scope_fkey",
		}),
	unique("uq_runs_space_id_id").on(table.id, table.spaceId),
	check("ck_runs_data_exposure_level", sql`(data_exposure_level IS NULL) OR ((data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text]))`),
	check("ck_runs_externality_level", sql`(externality_level IS NULL) OR ((externality_level)::text = ANY (ARRAY[('native'::character varying)::text, ('local_external'::character varying)::text, ('remote_external'::character varying)::text, ('hybrid'::character varying)::text, ('manual'::character varying)::text]))`),
	check("ck_runs_mode", sql`(mode)::text = ANY (ARRAY[('live'::character varying)::text, ('dry_run'::character varying)::text])`),
	check("ck_runs_run_role", sql`(run_role)::text = ANY (ARRAY[('execution'::character varying)::text, ('coordinator'::character varying)::text])`),
	check("ck_runs_observability_level", sql`(observability_level IS NULL) OR ((observability_level)::text = ANY (ARRAY[('full_trace'::character varying)::text, ('structured_events'::character varying)::text, ('artifacts_only'::character varying)::text, ('final_output_only'::character varying)::text, ('black_box'::character varying)::text]))`),
	check("ck_runs_required_sandbox_level", sql`(required_sandbox_level)::text = ANY (ARRAY[('none'::character varying)::text, ('dry_run'::character varying)::text, ('ephemeral'::character varying)::text, ('read_only'::character varying)::text, ('worktree'::character varying)::text, ('one_shot_docker'::character varying)::text])`),
	check("ck_runs_run_type", sql`(run_type)::text = ANY (ARRAY[('agent'::character varying)::text, ('planning'::character varying)::text, ('system'::character varying)::text, ('workflow'::character varying)::text, ('validation'::character varying)::text, ('reflection'::character varying)::text, ('export'::character varying)::text, ('evolution'::character varying)::text])`),
	check("ck_runs_source", sql`(source IS NULL) OR ((source)::text = ANY (ARRAY[('managed'::character varying)::text, ('ide_assist'::character varying)::text, ('manual_import'::character varying)::text, ('remote_import'::character varying)::text, ('scheduled'::character varying)::text, ('webhook'::character varying)::text]))`),
	check("ck_runs_status", sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('cancelling'::character varying)::text, ('succeeded'::character varying)::text, ('degraded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('orphaned'::character varying)::text, ('waiting_for_review'::character varying)::text, ('waiting_for_dependency'::character varying)::text])`),
	check("ck_runs_trigger_origin", sql`(trigger_origin)::text = ANY (ARRAY[('manual'::character varying)::text, ('automation'::character varying)::text, ('autonomous'::character varying)::text, ('job'::character varying)::text, ('system'::character varying)::text, ('delegation'::character varying)::text])`),
	check("ck_runs_trust_level", sql`(trust_level IS NULL) OR ((trust_level)::text = ANY (ARRAY[('high'::character varying)::text, ('medium'::character varying)::text, ('low'::character varying)::text, ('unknown'::character varying)::text]))`),
	check("ck_runs_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_runs_runtime_profile_selection_source", sql`runtime_profile_selection_source IS NULL OR runtime_profile_selection_source IN ('explicit', 'default')`),
	check("ck_runs_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_runs_private_owner", sql`visibility = 'space_shared' OR owner_user_id IS NOT NULL`),
]);

export const runAttempts = pgTable("run_attempts", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	attemptNumber: integer("attempt_number").notNull(),
	status: varchar({ length: 32 }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
	lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "string" }),
	cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true, mode: "string" }),
	cancelConfirmedAt: timestamp("cancel_confirmed_at", { withTimezone: true, mode: "string" }),
	exitCode: integer("exit_code"),
	errorCode: varchar("error_code", { length: 128 }),
	errorJson: jsonb("error_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_run_attempts_run_status").using("btree", table.spaceId.asc().nullsLast(), table.runId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_run_attempts_activity").using("btree", table.status.asc().nullsLast(), table.lastActivityAt.asc().nullsLast()),
	unique("uq_run_attempts_id_space").on(table.id, table.spaceId),
	unique("uq_run_attempts_space_run_number").on(table.spaceId, table.runId, table.attemptNumber),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "run_attempts_space_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.runId, table.spaceId],
		foreignColumns: [runs.id, runs.spaceId],
		name: "run_attempts_run_space_fkey",
	}).onDelete("cascade"),
	check("ck_run_attempts_attempt_number", sql`attempt_number > 0`),
	check("ck_run_attempts_status", sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('cancelling'::character varying)::text, ('succeeded'::character varying)::text, ('degraded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('orphaned'::character varying)::text, ('waiting_for_review'::character varying)::text])`),
]);

export const runSupervisorDecisions = pgTable("run_supervisor_decisions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	attemptId: varchar("attempt_id", { length: 36 }).notNull(),
	decision: varchar({ length: 32 }).notNull(),
	reasonCode: varchar("reason_code", { length: 128 }).notNull(),
	nextAttemptNumber: integer("next_attempt_number"),
	totalEstimatedCostUsd: doublePrecision("total_estimated_cost_usd"),
	maxCostUsd: doublePrecision("max_cost_usd"),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_run_supervisor_decisions_run").using("btree", table.spaceId.asc().nullsLast(), table.runId.asc().nullsLast(), table.createdAt.desc().nullsLast()),
	unique("uq_run_supervisor_decisions_attempt").on(table.spaceId, table.attemptId),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "run_supervisor_decisions_space_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.runId, table.spaceId],
		foreignColumns: [runs.id, runs.spaceId],
		name: "run_supervisor_decisions_run_space_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.attemptId, table.spaceId],
		foreignColumns: [runAttempts.id, runAttempts.spaceId],
		name: "run_supervisor_decisions_attempt_space_fkey",
	}).onDelete("cascade"),
	check("ck_run_supervisor_decisions_decision", sql`(decision)::text = ANY (ARRAY[('retry_same_route'::character varying)::text, ('retry_fallback_route'::character varying)::text, ('human_review'::character varying)::text, ('budget_exceeded'::character varying)::text, ('cancelled'::character varying)::text])`),
]);

export const externalRunRecords = pgTable("external_run_records", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	vendor: varchar({ length: 64 }).notNull(),
	vendorRunId: varchar("vendor_run_id", { length: 256 }),
	runtimeAdapterType: varchar("runtime_adapter_type", { length: 64 }),
	externalUrl: text("external_url"),
	observabilityLevel: varchar("observability_level", { length: 64 }).default('black_box').notNull(),
	dataExposureLevel: varchar("data_exposure_level", { length: 64 }).default('unknown').notNull(),
	traceAvailable: boolean("trace_available").default(false).notNull(),
	rawSummary: text("raw_summary"),
	rawOutputUri: varchar("raw_output_uri", { length: 1024 }),
	importedDiffUri: varchar("imported_diff_uri", { length: 1024 }),
	importedArtifactsJson: jsonb("imported_artifacts_json"),
	importedLogsUri: varchar("imported_logs_uri", { length: 1024 }),
	status: varchar({ length: 32 }).default('imported').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_external_run_records_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_external_run_records_runtime_adapter_type").using("btree", table.runtimeAdapterType.asc().nullsLast()),
	index("ix_external_run_records_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "external_run_records_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "external_run_records_space_id_fkey"
		}),
	check("ck_external_run_records_data_exposure_level", sql`(data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text])`),
	check("ck_external_run_records_observability_level", sql`(observability_level)::text = ANY (ARRAY[('full_trace'::character varying)::text, ('structured_events'::character varying)::text, ('artifacts_only'::character varying)::text, ('final_output_only'::character varying)::text, ('black_box'::character varying)::text])`),
	check("ck_external_run_records_vendor", sql`(vendor)::text = ANY (ARRAY[('openai'::character varying)::text, ('anthropic'::character varying)::text, ('cursor'::character varying)::text, ('opencode'::character varying)::text, ('manual'::character varying)::text, ('other'::character varying)::text])`),
]);

export const runExecutionLocks = pgTable("run_execution_locks", {
	runId: varchar("run_id", { length: 36 }).primaryKey().notNull(),
	lockedAt: timestamp("locked_at", { withTimezone: true, mode: 'string' }).notNull(),
	workerId: varchar("worker_id", { length: 64 }).notNull(),
	jobId: varchar("job_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [jobs.id],
			name: "fk_run_execution_locks_job_id_jobs"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "run_execution_locks_run_id_fkey"
		}),
]);

export const verificationResults = pgTable("verification_results", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	attemptNumber: integer("attempt_number").default(1).notNull(),
	verifierType: varchar("verifier_type", { length: 64 }).notNull(),
	verifierVersion: varchar("verifier_version", { length: 64 }).default('verification_engine.v1').notNull(),
	status: varchar({ length: 32 }).notNull(),
	summary: text(),
	evidenceRefsJson: jsonb("evidence_refs_json"),
	detailsJson: jsonb("details_json"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_verification_results_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_verification_results_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_verification_results_status").using("btree", table.status.asc().nullsLast()),
	index("ix_verification_results_run_status").using("btree", table.runId.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "verification_results_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "verification_results_space_id_fkey"
		}),
	unique("uq_verification_results_run_verifier").on(table.runId, table.attemptNumber, table.verifierType, table.verifierVersion),
	check("ck_verification_results_attempt_number", sql`attempt_number > 0`),
	check("ck_verification_results_status", sql`(status)::text = ANY (ARRAY[('passed'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('error'::character varying)::text])`),
]);

export const runSteps = pgTable("run_steps", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	attemptNumber: integer("attempt_number"),
	parentStepId: varchar("parent_step_id", { length: 36 }),
	actorId: varchar("actor_id", { length: 36 }).notNull(),
	stepIndex: integer("step_index").notNull(),
	stepType: varchar("step_type", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	title: varchar({ length: 512 }),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	sessionId: varchar("session_id", { length: 36 }),
	taskId: varchar("task_id", { length: 36 }),
	artifactId: varchar("artifact_id", { length: 36 }),
	proposalId: varchar("proposal_id", { length: 36 }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	inputSummary: text("input_summary"),
	outputSummary: text("output_summary"),
	errorType: varchar("error_type", { length: 128 }),
	errorMessage: text("error_message"),
	metadataJson: jsonb("metadata_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_run_steps_actor_id").using("btree", table.actorId.asc().nullsLast()),
	index("ix_run_steps_artifact_id").using("btree", table.artifactId.asc().nullsLast()),
	index("ix_run_steps_parent_step_id").using("btree", table.parentStepId.asc().nullsLast()),
	index("ix_run_steps_proposal_id").using("btree", table.proposalId.asc().nullsLast()),
	index("ix_run_steps_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_run_steps_session_id").using("btree", table.sessionId.asc().nullsLast()),
	index("ix_run_steps_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_run_steps_space_run_index").using("btree", table.spaceId.asc().nullsLast(), table.runId.asc().nullsLast(), table.stepIndex.asc().nullsLast()),
	index("ix_run_steps_status").using("btree", table.status.asc().nullsLast()),
	index("ix_run_steps_step_type").using("btree", table.stepType.asc().nullsLast()),
	index("ix_run_steps_task_id").using("btree", table.taskId.asc().nullsLast()),
	index("ix_run_steps_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	foreignKey({
			columns: [table.taskId],
			foreignColumns: [tasks.id],
			name: "fk_run_steps_task_id_tasks"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.actorId],
			foreignColumns: [actors.id],
			name: "run_steps_actor_id_fkey"
		}),
	foreignKey({
			columns: [table.artifactId],
			foreignColumns: [artifacts.id],
			name: "run_steps_artifact_id_fkey"
		}),
	foreignKey({
			columns: [table.parentStepId],
			foreignColumns: [table.id],
			name: "run_steps_parent_step_id_fkey"
		}),
	foreignKey({
			columns: [table.proposalId],
			foreignColumns: [proposals.id],
			name: "run_steps_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "run_steps_run_id_fkey"
		}),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [sessions.id],
			name: "run_steps_session_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "run_steps_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "run_steps_project_folder_id_fkey"
		}),
	unique("uq_run_steps_run_step_index").on(table.runId, table.stepIndex),
	check("ck_run_steps_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('cancelled'::character varying)::text])`),
	check("ck_run_steps_step_type", sql`(step_type)::text = ANY (ARRAY[('run_created'::character varying)::text, ('queued'::character varying)::text, ('runtime_selected'::character varying)::text, ('adapter_started'::character varying)::text, ('adapter_completed'::character varying)::text, ('artifact_created'::character varying)::text, ('proposal_created'::character varying)::text, ('failed'::character varying)::text, ('completed'::character varying)::text, ('validation_started'::character varying)::text, ('validation_completed'::character varying)::text, ('cancelled'::character varying)::text])`),
]);

export const runEvaluations = pgTable("run_evaluations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	evaluatorType: varchar("evaluator_type", { length: 64 }).default('deterministic_harness').notNull(),
	evaluatorVersion: varchar("evaluator_version", { length: 64 }).default('harness_eval.v1').notNull(),
	outcomeStatus: varchar("outcome_status", { length: 32 }).notNull(),
	failureLayer: varchar("failure_layer", { length: 32 }),
	failureReasonCode: varchar("failure_reason_code", { length: 128 }),
	trajectoryStatus: varchar("trajectory_status", { length: 32 }).notNull(),
	evidenceJson: jsonb("evidence_json"),
	ruleTraceJson: jsonb("rule_trace_json"),
	notes: text(),
	evaluatedAt: timestamp("evaluated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_run_evaluations_evaluated_at").using("btree", table.evaluatedAt.asc().nullsLast()),
	index("ix_run_evaluations_evaluator_version").using("btree", table.evaluatorVersion.asc().nullsLast()),
	index("ix_run_evaluations_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_run_evaluations_run_id_evaluated_at").using("btree", table.runId.asc().nullsLast(), table.evaluatedAt.asc().nullsLast()),
	index("ix_run_evaluations_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "run_evaluations_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "run_evaluations_space_id_fkey"
		}),
	check("ck_run_evaluations_failure_layer", sql`(failure_layer IS NULL) OR ((failure_layer)::text = ANY (ARRAY[('context'::character varying)::text, ('sandbox'::character varying)::text, ('runtime'::character varying)::text, ('tool'::character varying)::text, ('validation'::character varying)::text, ('policy'::character varying)::text, ('task_spec'::character varying)::text, ('orchestration'::character varying)::text, ('evaluator'::character varying)::text, ('unknown'::character varying)::text]))`),
	check("ck_run_evaluations_outcome_status", sql`(outcome_status)::text = ANY (ARRAY[('passed'::character varying)::text, ('failed'::character varying)::text, ('partial'::character varying)::text, ('unknown'::character varying)::text])`),
	check("ck_run_evaluations_trajectory_status", sql`(trajectory_status)::text = ANY (ARRAY[('acceptable'::character varying)::text, ('incomplete'::character varying)::text, ('unsafe'::character varying)::text, ('insufficient_evidence'::character varying)::text])`),
]);

export const runEvents = pgTable("run_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	attemptNumber: integer("attempt_number"),
	stepId: varchar("step_id", { length: 36 }),
	actorId: varchar("actor_id", { length: 36 }),
	eventIndex: integer("event_index").notNull(),
	eventType: varchar("event_type", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	summary: text(),
	errorCode: varchar("error_code", { length: 128 }),
	errorMessage: text("error_message"),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	artifactId: varchar("artifact_id", { length: 36 }),
	proposalId: varchar("proposal_id", { length: 36 }),
	dataExposureLevel: varchar("data_exposure_level", { length: 64 }),
	trustLevel: varchar("trust_level", { length: 32 }),
	metadataJson: jsonb("metadata_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_run_events_actor_id").using("btree", table.actorId.asc().nullsLast()),
	index("ix_run_events_artifact_id").using("btree", table.artifactId.asc().nullsLast()),
	index("ix_run_events_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("ix_run_events_error_code").using("btree", table.errorCode.asc().nullsLast()),
	index("ix_run_events_event_type").using("btree", table.eventType.asc().nullsLast()),
	index("ix_run_events_proposal_id").using("btree", table.proposalId.asc().nullsLast()),
	index("ix_run_events_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_run_events_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_run_events_status").using("btree", table.status.asc().nullsLast()),
	index("ix_run_events_step_id").using("btree", table.stepId.asc().nullsLast()),
	index("ix_run_events_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	uniqueIndex("uq_run_events_chat_completed").on(table.spaceId, table.runId).where(sql`event_type = 'chat_completed'`),
	foreignKey({
			columns: [table.actorId],
			foreignColumns: [actors.id],
			name: "run_events_actor_id_fkey"
		}),
	foreignKey({
			columns: [table.artifactId],
			foreignColumns: [artifacts.id],
			name: "run_events_artifact_id_fkey"
		}),
	foreignKey({
			columns: [table.proposalId],
			foreignColumns: [proposals.id],
			name: "run_events_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "run_events_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "run_events_space_id_fkey"
		}),
	foreignKey({
			columns: [table.stepId],
			foreignColumns: [runSteps.id],
			name: "run_events_step_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "run_events_project_folder_id_fkey"
		}),
	unique("uq_run_events_space_run_event_index").on(table.eventIndex, table.runId, table.spaceId),
	check("ck_run_events_data_exposure_level", sql`(data_exposure_level IS NULL) OR ((data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text]))`),
	check("ck_run_events_event_type", sql`(event_type)::text = ANY (ARRAY[('context_compiled'::character varying)::text, ('runtime_selected'::character varying)::text, ('credential_granted'::character varying)::text, ('sandbox_created'::character varying)::text, ('policy_checked'::character varying)::text, ('adapter_invoked'::character varying)::text, ('adapter_completed'::character varying)::text, ('artifact_ingested'::character varying)::text, ('patch_collected'::character varying)::text, ('validation_started'::character varying)::text, ('validation_completed'::character varying)::text, ('proposal_created'::character varying)::text, ('evaluation_created'::character varying)::text, ('run_finalized'::character varying)::text, ('chat_completed'::character varying)::text, ('delegation_requested'::character varying)::text, ('delegation_policy_denied'::character varying)::text, ('delegation_queued'::character varying)::text, ('delegation_started'::character varying)::text, ('delegation_completed'::character varying)::text, ('action_invoked'::character varying)::text, ('action_completed'::character varying)::text, ('assistant_message_completed'::character varying)::text, ('tool_call_started'::character varying)::text, ('tool_call_completed'::character varying)::text, ('tool_call_failed'::character varying)::text, ('approval_requested'::character varying)::text, ('approval_resolved'::character varying)::text, ('artifact_produced'::character varying)::text, ('output_validation_completed'::character varying)::text, ('provider_compacted'::character varying)::text, ('warning'::character varying)::text, ('error'::character varying)::text, ('state_transition'::character varying)::text])`),
	check("ck_run_events_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('warning'::character varying)::text, ('cancelled'::character varying)::text])`),
	check("ck_run_events_trust_level", sql`(trust_level IS NULL) OR ((trust_level)::text = ANY (ARRAY[('high'::character varying)::text, ('medium'::character varying)::text, ('low'::character varying)::text, ('unknown'::character varying)::text]))`),
]);

export const runFinalizations = pgTable("run_finalizations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	attemptNumber: integer("attempt_number").notNull(),
	finalizerVersion: varchar("finalizer_version", { length: 64 }).default('post_run_finalization.v1').notNull(),
	status: varchar({ length: 32 }).notNull(),
	runEvaluationId: varchar("run_evaluation_id", { length: 36 }),
	taskEvaluationId: varchar("task_evaluation_id", { length: 36 }),
	outcomeStatus: varchar("outcome_status", { length: 32 }),
	failureLayer: varchar("failure_layer", { length: 32 }),
	failureReasonCode: varchar("failure_reason_code", { length: 128 }),
	trajectoryStatus: varchar("trajectory_status", { length: 32 }),
	skippedReasonsJson: jsonb("skipped_reasons_json"),
	errorJson: jsonb("error_json"),
	metadataJson: jsonb("metadata_json"),
	finalizedAt: timestamp("finalized_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_run_finalizations_finalized_at").using("btree", table.finalizedAt.asc().nullsLast()),
	index("ix_run_finalizations_run_evaluation_id").using("btree", table.runEvaluationId.asc().nullsLast()),
	index("ix_run_finalizations_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_run_finalizations_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_run_finalizations_task_evaluation_id").using("btree", table.taskEvaluationId.asc().nullsLast()),
	foreignKey({
			columns: [table.runEvaluationId],
			foreignColumns: [runEvaluations.id],
			name: "run_finalizations_run_evaluation_id_fkey"
		}),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "run_finalizations_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "run_finalizations_space_id_fkey"
		}),
	foreignKey({
			columns: [table.taskEvaluationId],
			foreignColumns: [taskEvaluations.id],
			name: "run_finalizations_task_evaluation_id_fkey"
		}),
	unique("uq_run_finalizations_run_attempt_version").on(table.spaceId, table.runId, table.attemptNumber, table.finalizerVersion),
	check("ck_run_finalizations_attempt_number", sql`attempt_number > 0`),
	check("ck_run_finalizations_failure_layer", sql`(failure_layer IS NULL) OR ((failure_layer)::text = ANY (ARRAY[('context'::character varying)::text, ('sandbox'::character varying)::text, ('runtime'::character varying)::text, ('tool'::character varying)::text, ('validation'::character varying)::text, ('policy'::character varying)::text, ('task_spec'::character varying)::text, ('orchestration'::character varying)::text, ('evaluator'::character varying)::text, ('unknown'::character varying)::text]))`),
	check("ck_run_finalizations_outcome_status", sql`(outcome_status IS NULL) OR ((outcome_status)::text = ANY (ARRAY[('passed'::character varying)::text, ('failed'::character varying)::text, ('partial'::character varying)::text, ('unknown'::character varying)::text]))`),
	check("ck_run_finalizations_status", sql`(status)::text = ANY (ARRAY[('completed'::character varying)::text, ('failed'::character varying)::text])`),
	check("ck_run_finalizations_trajectory_status", sql`(trajectory_status IS NULL) OR ((trajectory_status)::text = ANY (ARRAY[('acceptable'::character varying)::text, ('incomplete'::character varying)::text, ('unsafe'::character varying)::text, ('insufficient_evidence'::character varying)::text]))`),
]);

export const taskEvaluations = pgTable("task_evaluations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	taskId: varchar("task_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }),
	runEvaluationId: varchar("run_evaluation_id", { length: 36 }),
	evaluatorType: varchar("evaluator_type", { length: 32 }).notNull(),
	evaluatorUserId: varchar("evaluator_user_id", { length: 36 }),
	evaluatorAgentId: varchar("evaluator_agent_id", { length: 36 }),
	score: doublePrecision(),
	confidence: doublePrecision(),
	summary: text(),
	checklistJson: jsonb("checklist_json"),
	knownIssuesJson: jsonb("known_issues_json"),
	evidenceArtifactIds: jsonb("evidence_artifact_ids"),
	recommendation: varchar({ length: 64 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_task_evaluations_run_evaluation_id").using("btree", table.runEvaluationId.asc().nullsLast()),
	index("ix_task_evaluations_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_task_evaluations_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_task_evaluations_task_id").using("btree", table.taskId.asc().nullsLast()),
	foreignKey({
			columns: [table.evaluatorAgentId],
			foreignColumns: [agents.id],
			name: "task_evaluations_evaluator_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.evaluatorUserId],
			foreignColumns: [users.id],
			name: "task_evaluations_evaluator_user_id_fkey"
		}),
	foreignKey({
			columns: [table.runEvaluationId],
			foreignColumns: [runEvaluations.id],
			name: "task_evaluations_run_evaluation_id_fkey"
		}),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "task_evaluations_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "task_evaluations_space_id_fkey"
		}),
	foreignKey({
			columns: [table.taskId],
			foreignColumns: [tasks.id],
			name: "task_evaluations_task_id_fkey"
		}),
]);

export const taskRuns = pgTable("task_runs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	taskId: varchar("task_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	role: varchar({ length: 32 }).default('primary').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_task_runs_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_task_runs_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_task_runs_task_id").using("btree", table.taskId.asc().nullsLast()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "task_runs_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "task_runs_space_id_fkey"
		}),
	foreignKey({
			columns: [table.taskId],
			foreignColumns: [tasks.id],
			name: "task_runs_task_id_fkey"
		}),
	unique("uq_task_runs_task_run").on(table.runId, table.taskId),
]);
