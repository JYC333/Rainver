import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { users } from "./auth";
import { runs } from "./runs";
import { artifacts } from "./artifacts";
import { workflowExecutions } from "./automations";

export const projectOperations = pgTable("project_operations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	kind: varchar({ length: 32 }).notNull(),
	title: varchar({ length: 256 }).notNull(),
	intentText: text("intent_text"),
	status: varchar({ length: 32 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	initiatingRunId: varchar("initiating_run_id", { length: 36 }),
	planArtifactId: varchar("plan_artifact_id", { length: 36 }),
	progressJson: jsonb("progress_json").default({}).notNull(),
	version: integer().default(1).notNull(),
	// The operation's current (or most recent) pass. A retry/resume/rescan
	// creates a new WorkflowExecution and repoints this rather than reopening
	// the old one — WorkflowExecution's engine is a strict per-pass DAG, not
	// a cyclic state machine, so a "pass" is never revisited.
	currentExecutionId: varchar("current_execution_id", { length: 36 }),
	// Incremented each time a new WorkflowExecution pass is started for this
	// operation. Purely observational bookkeeping — correctness against
	// stale/late writes comes from `currentExecutionId` guards and
	// `workflow_execution_node_runs` scoping, not from this counter.
	generation: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	index("ix_project_operations_project_status").on(t.projectId, t.status),
	uniqueIndex("uq_project_operations_active_research_workflow").using(
		"btree",
		t.spaceId.asc().nullsLast(),
		sql`(progress_json->>'workflow_id')`,
	).where(sql`kind = 'research' AND status IN ('active', 'waiting_review') AND progress_json->>'workflow_id' IS NOT NULL`),
	foreignKey({ columns: [t.projectId, t.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "project_operations_project_fkey" }),
	foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "project_operations_space_fkey" }),
	foreignKey({ columns: [t.createdByUserId], foreignColumns: [users.id], name: "project_operations_user_fkey" }),
	foreignKey({ columns: [t.initiatingRunId, t.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "project_operations_run_fkey" }),
	foreignKey({ columns: [t.planArtifactId, t.spaceId], foreignColumns: [artifacts.id, artifacts.spaceId], name: "project_operations_artifact_fkey" }),
	foreignKey({ columns: [t.currentExecutionId, t.spaceId], foreignColumns: [workflowExecutions.id, workflowExecutions.spaceId], name: "project_operations_current_execution_fkey" }),
	unique("uq_project_operations_space_id_id").on(t.id, t.spaceId),
	unique("uq_project_operations_id_project_space").on(t.id, t.projectId, t.spaceId),
	check("ck_project_operations_kind", sql`kind IN ('source_setup','source_backfill','research','custom')`),
	check("ck_project_operations_status", sql`status IN ('draft','active','waiting_review','completed','failed','cancelled')`),
	check("ck_project_operations_version", sql`version >= 1`),
	check("ck_project_operations_generation", sql`generation >= 0`),
]);

export const projectOperationSteps = pgTable("project_operation_steps", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	operationId: varchar("operation_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	seq: integer().notNull(),
	title: varchar({ length: 256 }).notNull(),
	status: varchar({ length: 16 }).notNull(),
	detailJson: jsonb("detail_json").default({}).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	foreignKey({ columns: [t.operationId, t.spaceId], foreignColumns: [projectOperations.id, projectOperations.spaceId], name: "project_operation_steps_operation_fkey" }).onDelete("cascade"),
	unique("uq_project_operation_steps_seq").on(t.operationId, t.seq),
	check("ck_project_operation_steps_status", sql`status IN ('pending','active','blocked','done','skipped')`),
]);

export const projectOperationLinks = pgTable("project_operation_links", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	operationId: varchar("operation_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	targetType: varchar("target_type", { length: 32 }).notNull(),
	targetId: varchar("target_id", { length: 256 }).notNull(),
	role: varchar({ length: 64 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	index("ix_project_operation_links_target").on(t.spaceId, t.targetType, t.targetId),
	foreignKey({ columns: [t.operationId, t.spaceId], foreignColumns: [projectOperations.id, projectOperations.spaceId], name: "project_operation_links_operation_fkey" }).onDelete("cascade"),
	unique("uq_project_operation_links_target").on(t.operationId, t.targetType, t.targetId),
	check("ck_project_operation_links_target_type", sql`target_type IN ('run','job','proposal','artifact','source_backfill_plan','project_source_binding','corpus_sync','research_workflow')`),
]);
