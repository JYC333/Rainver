import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./auth";
import { spaces } from "./spaces";
import { projectFolders } from "./projectFolders";
import { projects } from "./projects";
import { runs } from "./runs";
import { evolvableAssetVersions } from "./evolvableAssets";

export const automations = pgTable("automations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	projectId: varchar("project_id", { length: 36 }),
	name: varchar({ length: 256 }).notNull(),
	description: text(),
	triggerType: varchar("trigger_type", { length: 64 }).default('manual').notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	preflightSnapshotJson: jsonb("preflight_snapshot_json"),
	configJson: jsonb("config_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_automations_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_automations_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_automations_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_automations_space_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	index("ix_automations_status").using("btree", table.status.asc().nullsLast()),
	index("ix_automations_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	unique("uq_automations_id_space_id").on(table.id, table.spaceId),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "automations_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "automations_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "automations_project_id_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "automations_project_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "automations_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "automations_project_folder_id_fkey"
		}),
	check("ck_automations_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_automations_trigger_type", sql`(trigger_type)::text = ANY (ARRAY[('manual'::character varying)::text, ('schedule'::character varying)::text])`),
]);

export const automationCredentialGrants = pgTable("automation_credential_grants", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	automationId: varchar("automation_id", { length: 36 }).notNull(),
	grantedByUserId: varchar("granted_by_user_id", { length: 36 }).notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	revokedByUserId: varchar("revoked_by_user_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_automation_credential_grants_automation_id").using("btree", table.automationId.asc().nullsLast()),
	index("ix_automation_credential_grants_granted_by_user_id").using("btree", table.grantedByUserId.asc().nullsLast()),
	index("ix_automation_credential_grants_lookup").using("btree", table.spaceId.asc().nullsLast(), table.automationId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_automation_credential_grants_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_automation_credential_grants_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.automationId],
			foreignColumns: [automations.id],
			name: "automation_credential_grants_automation_id_fkey"
		}),
	foreignKey({
			columns: [table.grantedByUserId],
			foreignColumns: [users.id],
			name: "automation_credential_grants_granted_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.revokedByUserId],
			foreignColumns: [users.id],
			name: "automation_credential_grants_revoked_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "automation_credential_grants_space_id_fkey"
		}),
	check("ck_automation_credential_grants_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('revoked'::character varying)::text])`),
]);

export const workflowExecutions = pgTable("workflow_executions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	automationId: varchar("automation_id", { length: 36 }).notNull(),
	workflowVersionId: varchar("workflow_version_id", { length: 36 }).notNull(),
	rootRunId: varchar("root_run_id", { length: 36 }),
	status: varchar({ length: 32 }).default('queued').notNull(),
	triggerType: varchar("trigger_type", { length: 64 }).notNull(),
	inputJson: jsonb("input_json").default({}).notNull(),
	definitionJson: jsonb("definition_json").notNull(),
	resolutionTraceJson: jsonb("resolution_trace_json").default({}).notNull(),
	contractSnapshotJson: jsonb("contract_snapshot_json").default({}).notNull(),
	budgetSnapshotJson: jsonb("budget_snapshot_json").default({}).notNull(),
	// Loose (non-FK) cross-domain identifier, not a `project_operations`
	// ownership link: a caller-supplied Project Research operation id, used
	// only to enforce "at most one active pass per operation" below. No FK
	// to avoid a schema import cycle with projectOperations.ts (ADR 0011's
	// loose cross-domain identifier pattern, e.g. retrieval_edges).
	researchOperationId: varchar("research_operation_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_workflow_executions_automation_created").using("btree", table.spaceId.asc().nullsLast(), table.automationId.asc().nullsLast(), table.createdAt.desc().nullsLast()),
	index("ix_workflow_executions_status").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_workflow_executions_root_run").using("btree", table.spaceId.asc().nullsLast(), table.rootRunId.asc().nullsLast()),
	unique("uq_workflow_executions_id_space_id").on(table.id, table.spaceId),
	unique("uq_workflow_executions_id_automation_id").on(table.id, table.automationId),
	// At most one active (queued/running) pass per Project Research operation
	// — the DB-level half of "single active Execution per Operation"; the
	// app also locks the operation row before starting a new pass.
	uniqueIndex("uq_workflow_executions_active_research_operation").using("btree", table.researchOperationId.asc().nullsLast())
		.where(sql`research_operation_id IS NOT NULL AND status IN ('queued', 'running')`),
	foreignKey({ columns: [table.automationId, table.spaceId], foreignColumns: [automations.id, automations.spaceId], name: "workflow_executions_automation_space_fkey" }),
	foreignKey({ columns: [table.rootRunId], foreignColumns: [runs.id], name: "workflow_executions_root_run_delete_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.rootRunId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "workflow_executions_root_run_space_fkey" }),
	foreignKey({ columns: [table.workflowVersionId], foreignColumns: [evolvableAssetVersions.id], name: "workflow_executions_workflow_version_fkey" }),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "workflow_executions_space_id_fkey" }),
]);

export const workflowExecutionNodes = pgTable("workflow_execution_nodes", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	executionId: varchar("execution_id", { length: 36 }).notNull(),
	nodeKey: varchar("node_key", { length: 128 }).notNull(),
	nodeKind: varchar("node_kind", { length: 32 }).notNull(),
	title: varchar({ length: 512 }).notNull(),
	description: text(),
	status: varchar({ length: 64 }).default('inbox').notNull(),
	assignedAgentId: varchar("assigned_agent_id", { length: 36 }),
	runtimeProfileId: varchar("runtime_profile_id", { length: 36 }),
	capabilityId: varchar("capability_id", { length: 128 }),
	promptAssetKey: varchar("prompt_asset_key", { length: 256 }),
	riskLevel: varchar("risk_level", { length: 32 }).default('low').notNull(),
	contractJson: jsonb("contract_json").default({}).notNull(),
	inputBindingsJson: jsonb("input_bindings_json").default([]).notNull(),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	blockedReason: text("blocked_reason"),
	approvalProposalId: varchar("approval_proposal_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_workflow_execution_nodes_execution_status").using("btree", table.spaceId.asc().nullsLast(), table.executionId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_workflow_execution_nodes_capability").using("btree", table.spaceId.asc().nullsLast(), table.capabilityId.asc().nullsLast()),
	unique("uq_workflow_execution_nodes_key").on(table.executionId, table.nodeKey),
	unique("uq_workflow_execution_nodes_id_space").on(table.id, table.spaceId),
	foreignKey({ columns: [table.executionId, table.spaceId], foreignColumns: [workflowExecutions.id, workflowExecutions.spaceId], name: "workflow_execution_nodes_execution_space_fkey" }),
	foreignKey({ columns: [table.assignedAgentId], foreignColumns: [agents.id], name: "workflow_execution_nodes_agent_delete_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.assignedAgentId, table.spaceId], foreignColumns: [agents.id, agents.spaceId], name: "workflow_execution_nodes_agent_space_fkey" }),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "workflow_execution_nodes_space_id_fkey" }),
	check("ck_workflow_execution_nodes_status", sql`status IN ('inbox', 'ready', 'in_progress', 'blocked', 'waiting_for_review', 'done', 'failed')`),
]);

export const workflowExecutionDependencies = pgTable("workflow_execution_dependencies", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	executionId: varchar("execution_id", { length: 36 }).notNull(),
	nodeId: varchar("node_id", { length: 36 }).notNull(),
	dependsOnNodeId: varchar("depends_on_node_id", { length: 36 }).notNull(),
	dependencyType: varchar("dependency_type", { length: 32 }).default('requires').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_workflow_execution_dependencies_node").using("btree", table.spaceId.asc().nullsLast(), table.nodeId.asc().nullsLast()),
	index("ix_workflow_execution_dependencies_depends_on").using("btree", table.spaceId.asc().nullsLast(), table.dependsOnNodeId.asc().nullsLast()),
	unique("uq_workflow_execution_dependencies_edge").on(table.nodeId, table.dependsOnNodeId),
	foreignKey({ columns: [table.executionId, table.spaceId], foreignColumns: [workflowExecutions.id, workflowExecutions.spaceId], name: "workflow_execution_dependencies_execution_space_fkey" }),
	foreignKey({ columns: [table.nodeId, table.spaceId], foreignColumns: [workflowExecutionNodes.id, workflowExecutionNodes.spaceId], name: "workflow_execution_dependencies_node_space_fkey" }),
	foreignKey({ columns: [table.dependsOnNodeId, table.spaceId], foreignColumns: [workflowExecutionNodes.id, workflowExecutionNodes.spaceId], name: "workflow_execution_dependencies_depends_on_space_fkey" }),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "workflow_execution_dependencies_space_id_fkey" }),
]);

export const workflowExecutionNodeRuns = pgTable("workflow_execution_node_runs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	nodeId: varchar("node_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	role: varchar("role", { length: 32 }).default('primary').notNull(),
	resolvedInputsJson: jsonb("resolved_inputs_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_workflow_execution_node_runs_node").using("btree", table.spaceId.asc().nullsLast(), table.nodeId.asc().nullsLast()),
	index("ix_workflow_execution_node_runs_run").using("btree", table.spaceId.asc().nullsLast(), table.runId.asc().nullsLast()),
	unique("uq_workflow_execution_node_runs_node_run").on(table.nodeId, table.runId),
	foreignKey({ columns: [table.nodeId, table.spaceId], foreignColumns: [workflowExecutionNodes.id, workflowExecutionNodes.spaceId], name: "workflow_execution_node_runs_node_space_fkey" }),
	foreignKey({ columns: [table.runId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "workflow_execution_node_runs_run_space_fkey" }),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "workflow_execution_node_runs_space_id_fkey" }),
]);

export const automationRuns = pgTable("automation_runs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	automationId: varchar("automation_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	workflowExecutionId: varchar("workflow_execution_id", { length: 36 }),
	triggeredByUserId: varchar("triggered_by_user_id", { length: 36 }),
	triggerType: varchar("trigger_type", { length: 64 }).default('manual').notNull(),
	preflightSnapshotJson: jsonb("preflight_snapshot_json"),
	triggerContextJson: jsonb("trigger_context_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_automation_runs_automation_created").using("btree", table.automationId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_automation_runs_automation_id").using("btree", table.automationId.asc().nullsLast()),
	index("ix_automation_runs_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_automation_runs_workflow_execution_id").using("btree", table.workflowExecutionId.asc().nullsLast()),
	index("ix_automation_runs_triggered_by_user_id").using("btree", table.triggeredByUserId.asc().nullsLast()),
	foreignKey({
			columns: [table.automationId],
			foreignColumns: [automations.id],
			name: "automation_runs_automation_id_fkey"
		}),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "automation_runs_run_id_fkey"
		}),
	foreignKey({
			columns: [table.workflowExecutionId, table.automationId],
			foreignColumns: [workflowExecutions.id, workflowExecutions.automationId],
			name: "automation_runs_workflow_execution_automation_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.triggeredByUserId],
			foreignColumns: [users.id],
			name: "automation_runs_triggered_by_user_id_fkey"
		}),
]);
