import { pgTable, index, unique, check, foreignKey, varchar, text, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { projects } from "./projects.js";
import { spaceObjects } from "./knowledge.js";

// Decision Domain: a resolved Inquiry
// findings -> Create Decision Case" action). A Decision Case is a
// Project-owned root table, never a `space_objects` row, mirroring
// InquiryThread's ownership pattern (ADR 0011 decision 1) — this is a
// structured decision record with its own lifecycle, not Ontology content.
export const decisionCases = pgTable("decision_cases", {
	// Ontology object (ADR 0012 / ADR 0011 decision 1). Identity, title,
	// visibility, ownership, provenance, and timestamps live on `space_objects`;
	// `project_id` stays because sibling tables key their tenant-integrity FKs
	// on (case, project, space).
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	framing: text(),
	status: varchar({ length: 16 }).default('open').notNull(),
	decidedOptionId: varchar("decided_option_id", { length: 36 }),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	decidedByUserId: varchar("decided_by_user_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_decision_cases_project_status").using("btree", table.projectId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_decision_cases_decided_option_id").using("btree", table.decidedOptionId.asc().nullsLast()),
	unique("uq_decision_cases_id_space_id").on(table.objectId, table.spaceId),
	foreignKey({ columns: [table.objectId, table.spaceId], foreignColumns: [spaceObjects.id, spaceObjects.spaceId], name: "decision_cases_object_id_fkey" }).onDelete("cascade"),
	unique("uq_decision_cases_id_project_space").on(table.objectId, table.projectId, table.spaceId),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "decision_cases_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "decision_cases_space_id_fkey" }),
	// decidedOptionId is intentionally not a DB-level FK: it and
	// decision_options are mutually referential within the same file
	// (an Option's own FK already pins it to its Case), and the service
	// layer's decide() already validates the option belongs to this exact
	// Case and is 'active' before setting this column.
	foreignKey({ columns: [table.decidedByUserId], foreignColumns: [users.id], name: "decision_cases_decided_by_user_id_fkey" }).onDelete("set null"),
	check("ck_decision_cases_status", sql`(status)::text = ANY (ARRAY[('open'::character varying)::text, ('decided'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_decision_cases_decided_pairing", sql`(status)::text <> 'decided'::text OR (decided_option_id IS NOT NULL AND decided_at IS NOT NULL)`),
]);

export const decisionOptions = pgTable("decision_options", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	decisionCaseId: varchar("decision_case_id", { length: 36 }).notNull(),
	title: varchar({ length: 512 }).notNull(),
	description: text(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_decision_options_case").using("btree", table.decisionCaseId.asc().nullsLast()),
	unique("uq_decision_options_id_space_id").on(table.id, table.spaceId),
	unique("uq_decision_options_id_case_space").on(table.id, table.decisionCaseId, table.spaceId),
	foreignKey({ columns: [table.decisionCaseId, table.spaceId], foreignColumns: [decisionCases.objectId, decisionCases.spaceId], name: "decision_options_case_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "decision_options_space_id_fkey" }),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "decision_options_created_by_user_id_fkey" }).onDelete("set null"),
	check("ck_decision_options_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('withdrawn'::character varying)::text])`),
]);

export const decisionCriteria = pgTable("decision_criteria", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	decisionCaseId: varchar("decision_case_id", { length: 36 }).notNull(),
	name: varchar({ length: 256 }).notNull(),
	weight: integer().default(3).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_decision_criteria_case").using("btree", table.decisionCaseId.asc().nullsLast()),
	unique("uq_decision_criteria_id_space_id").on(table.id, table.spaceId),
	unique("uq_decision_criteria_id_case_space").on(table.id, table.decisionCaseId, table.spaceId),
	foreignKey({ columns: [table.decisionCaseId, table.spaceId], foreignColumns: [decisionCases.objectId, decisionCases.spaceId], name: "decision_criteria_case_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "decision_criteria_space_id_fkey" }),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "decision_criteria_created_by_user_id_fkey" }).onDelete("set null"),
	check("ck_decision_criteria_weight", sql`weight BETWEEN 1 AND 5`),
]);

// Trade-offs matrix: exactly one score per (option, criterion) pair. Both
// composite FKs pin the option and criterion to the SAME Decision Case, so a
// score can never silently reference a criterion from a different Case.
export const decisionOptionScores = pgTable("decision_option_scores", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	decisionCaseId: varchar("decision_case_id", { length: 36 }).notNull(),
	optionId: varchar("option_id", { length: 36 }).notNull(),
	criterionId: varchar("criterion_id", { length: 36 }).notNull(),
	score: integer().notNull(),
	rationale: text(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_decision_option_scores_case").using("btree", table.decisionCaseId.asc().nullsLast()),
	unique("uq_decision_option_scores_option_criterion").on(table.optionId, table.criterionId),
	foreignKey({ columns: [table.optionId, table.decisionCaseId, table.spaceId], foreignColumns: [decisionOptions.id, decisionOptions.decisionCaseId, decisionOptions.spaceId], name: "decision_option_scores_option_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.criterionId, table.decisionCaseId, table.spaceId], foreignColumns: [decisionCriteria.id, decisionCriteria.decisionCaseId, decisionCriteria.spaceId], name: "decision_option_scores_criterion_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "decision_option_scores_space_id_fkey" }),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "decision_option_scores_created_by_user_id_fkey" }).onDelete("set null"),
	check("ck_decision_option_scores_score", sql`score BETWEEN 1 AND 5`),
]);

// The Commitment is what turns a decided Case into an actionable statement;
// createdDeliveryTaskId is set only after the explicit "Decision -> Create
// Delivery Outcome" action (plan section 5.1) runs — a reference, never a
// copy of the Commitment into modules/tasks.
export const decisionCommitments = pgTable("decision_commitments", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	decisionCaseId: varchar("decision_case_id", { length: 36 }).notNull(),
	statement: text().notNull(),
	committedByUserId: varchar("committed_by_user_id", { length: 36 }),
	committedAt: timestamp("committed_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdDeliveryTaskId: varchar("created_delivery_task_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_decision_commitments_case").using("btree", table.decisionCaseId.asc().nullsLast()),
	foreignKey({ columns: [table.decisionCaseId, table.spaceId], foreignColumns: [decisionCases.objectId, decisionCases.spaceId], name: "decision_commitments_case_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "decision_commitments_space_id_fkey" }),
	foreignKey({ columns: [table.committedByUserId], foreignColumns: [users.id], name: "decision_commitments_committed_by_user_id_fkey" }).onDelete("set null"),
]);
