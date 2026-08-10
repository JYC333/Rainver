import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, jsonb, doublePrecision, boolean, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { spaceObjects } from "./knowledge";
import { inquiryThreads } from "./inquiry";

// Experiment Domain. Replaces the earlier, narrower
// `project_experiment_campaigns`/`_runs`/`_provenance` model: a code/prompt
// A-B comparison becomes one `executor_type` this domain supports
// (`managed_code_comparison`), not a second top-level Experiment concept.
// Definition -> Version (immutable config) -> Run (immutable config
// snapshot) -> Observation (raw recorded data) -> Interpretation (reviewed
// conclusion, convertible to an Inquiry Evidence Signal).

export const experimentDefinitions = pgTable("experiment_definitions", {
	// Ontology object (ADR 0012 / ADR 0011 decision 1). The former `name` is the
	// root's `title`; identity, visibility, ownership, provenance, and timestamps
	// live on `space_objects`.
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	objective: text(),
	// The primary Hypothesis Thread this Experiment tests. Nullable:
	// an Experiment may be drafted before a formal Hypothesis Thread exists,
	// but the target is required and frozen before its first Run.
	primaryHypothesisThreadId: varchar("primary_hypothesis_thread_id", { length: 36 }),
	status: varchar({ length: 16 }).default('draft').notNull(),
	baselineRunId: varchar("baseline_run_id", { length: 36 }),
	bestRunId: varchar("best_run_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_experiment_definitions_project_id").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	index("ix_experiment_definitions_thread_id").using("btree", table.primaryHypothesisThreadId.asc().nullsLast()),
	unique("uq_experiment_definitions_id_space_id").on(table.objectId, table.spaceId),
	foreignKey({ columns: [table.objectId, table.spaceId], foreignColumns: [spaceObjects.id, spaceObjects.spaceId], name: "experiment_definitions_object_id_fkey" }).onDelete("cascade"),
	unique("uq_experiment_definitions_id_project_space").on(table.objectId, table.projectId, table.spaceId),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "experiment_definitions_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "experiment_definitions_space_id_fkey" }),
	foreignKey({ columns: [table.primaryHypothesisThreadId, table.projectId, table.spaceId], foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId], name: "experiment_definitions_thread_fkey" }),
	foreignKey({ columns: [table.baselineRunId], foreignColumns: [experimentRuns.id], name: "experiment_definitions_baseline_run_delete_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.baselineRunId, table.spaceId], foreignColumns: [experimentRuns.id, experimentRuns.spaceId], name: "experiment_definitions_baseline_run_id_fkey" }),
	foreignKey({ columns: [table.bestRunId], foreignColumns: [experimentRuns.id], name: "experiment_definitions_best_run_delete_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.bestRunId, table.spaceId], foreignColumns: [experimentRuns.id, experimentRuns.spaceId], name: "experiment_definitions_best_run_id_fkey" }),
	check("ck_experiment_definitions_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('paused'::character varying)::text, ('completed'::character varying)::text, ('archived'::character varying)::text])`),
]);

export const experimentVersions = pgTable("experiment_versions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	definitionId: varchar("definition_id", { length: 36 }).notNull(),
	version: integer().notNull(),
	// "manual": no execution config, the Run is a human-recorded observation.
	// "managed_code_comparison": the old Campaign's config shape, carried in
	// config_json (project_folder_id, editable/protected scope, setup_commands,
	// run_command, metric_parser, time_budget_seconds, timeout_seconds,
	// resource_budget) — see runService.ts for the exact keys and validation.
	executorType: varchar("executor_type", { length: 32 }).notNull(),
	configJson: jsonb("config_json").default({}).notNull(),
	plannedSummary: text("planned_summary"),
	status: varchar({ length: 16 }).default('draft').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_experiment_versions_definition_id").using("btree", table.spaceId.asc().nullsLast(), table.definitionId.asc().nullsLast()),
	unique("uq_experiment_versions_id_space_id").on(table.id, table.spaceId),
	uniqueIndex("uq_experiment_versions_definition_version").using("btree", table.definitionId.asc().nullsLast(), table.version.asc().nullsLast()),
	foreignKey({ columns: [table.definitionId, table.spaceId], foreignColumns: [experimentDefinitions.objectId, experimentDefinitions.spaceId], name: "experiment_versions_definition_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "experiment_versions_space_id_fkey" }),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "experiment_versions_created_by_user_id_fkey" }).onDelete("set null"),
	check("ck_experiment_versions_executor_type", sql`(executor_type)::text = ANY (ARRAY[('manual'::character varying)::text, ('managed_code_comparison'::character varying)::text])`),
	check("ck_experiment_versions_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('approved'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_experiment_versions_config_object", sql`jsonb_typeof(config_json) = 'object'::text`),
]);

export const experimentRuns = pgTable("experiment_runs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	versionId: varchar("version_id", { length: 36 }).notNull(),
	// Set only for a managed/agent-executed run; a manual Run has none — the
	// human records Observations directly.
	runId: varchar("run_id", { length: 36 }),
	isBaseline: boolean("is_baseline").default(false).notNull(),
	hypothesis: text(),
	patchSummary: text("patch_summary"),
	commitRef: varchar("commit_ref", { length: 128 }),
	status: varchar({ length: 16 }).default('queued').notNull(),
	// Immutable copy of the Version's config_json at Run creation time — a
	// later edit to the Version (a new Version row) never changes what an
	// already-created Run is reproducible from.
	configSnapshotJson: jsonb("config_snapshot_json").default({}).notNull(),
	artifactIdsJson: jsonb("artifact_ids_json").default([]).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_experiment_runs_version_id").using("btree", table.spaceId.asc().nullsLast(), table.versionId.asc().nullsLast()),
	unique("uq_experiment_runs_id_space_id").on(table.id, table.spaceId),
	foreignKey({ columns: [table.versionId, table.spaceId], foreignColumns: [experimentVersions.id, experimentVersions.spaceId], name: "experiment_runs_version_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.runId], foreignColumns: [runs.id], name: "experiment_runs_run_delete_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.runId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "experiment_runs_run_id_fkey" }),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "experiment_runs_space_id_fkey" }),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "experiment_runs_created_by_user_id_fkey" }).onDelete("set null"),
	check("ck_experiment_runs_status", sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text])`),
	check("ck_experiment_runs_artifact_ids_array", sql`jsonb_typeof(artifact_ids_json) = 'array'::text`),
]);

export const experimentObservations = pgTable("experiment_observations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	metricName: varchar("metric_name", { length: 128 }).notNull(),
	valueNumber: doublePrecision("value_number"),
	valueText: text("value_text"),
	valueJson: jsonb("value_json"),
	isPrimary: boolean("is_primary").default(false).notNull(),
	source: varchar({ length: 16 }).default('manual').notNull(),
	recordedByUserId: varchar("recorded_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_experiment_observations_run_id").using("btree", table.spaceId.asc().nullsLast(), table.runId.asc().nullsLast()),
	foreignKey({ columns: [table.runId, table.spaceId], foreignColumns: [experimentRuns.id, experimentRuns.spaceId], name: "experiment_observations_run_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "experiment_observations_space_id_fkey" }),
	foreignKey({ columns: [table.recordedByUserId], foreignColumns: [users.id], name: "experiment_observations_recorded_by_user_id_fkey" }).onDelete("set null"),
	check("ck_experiment_observations_source", sql`(source)::text = ANY (ARRAY[('manual'::character varying)::text, ('parsed'::character varying)::text, ('agent'::character varying)::text])`),
	check("ck_experiment_observations_value_present", sql`value_number IS NOT NULL OR value_text IS NOT NULL OR value_json IS NOT NULL`),
]);

export const experimentInterpretations = pgTable("experiment_interpretations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	definitionId: varchar("definition_id", { length: 36 }).notNull(),
	runIdsJson: jsonb("run_ids_json").default([]).notNull(),
	verdict: varchar({ length: 16 }).notNull(),
	conclusion: text(),
	negativeResults: text("negative_results"),
	limitations: text(),
	reproLockJson: jsonb("repro_lock_json").default({}).notNull(),
	status: varchar({ length: 16 }).default('draft').notNull(),
	// Set once converted (see interpretationService.ts). A converted
	// Interpretation is immutable — this is the durable link a reviewed
	// experimental result leaves in the Inquiry Domain.
	resultingSignalId: varchar("resulting_signal_id", { length: 36 }),
	reviewedByUserId: varchar("reviewed_by_user_id", { length: 36 }),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_experiment_interpretations_definition_id").using("btree", table.spaceId.asc().nullsLast(), table.definitionId.asc().nullsLast()),
	index("ix_experiment_interpretations_project_id").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	unique("uq_experiment_interpretations_id_space_id").on(table.id, table.spaceId),
	unique("uq_experiment_interpretations_id_project_space").on(table.id, table.projectId, table.spaceId),
	foreignKey({ columns: [table.definitionId, table.spaceId], foreignColumns: [experimentDefinitions.objectId, experimentDefinitions.spaceId], name: "experiment_interpretations_definition_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "experiment_interpretations_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "experiment_interpretations_space_id_fkey" }),
	foreignKey({ columns: [table.reviewedByUserId], foreignColumns: [users.id], name: "experiment_interpretations_reviewed_by_user_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "experiment_interpretations_created_by_user_id_fkey" }).onDelete("set null"),
	check("ck_experiment_interpretations_verdict", sql`(verdict)::text = ANY (ARRAY[('supports'::character varying)::text, ('contradicts'::character varying)::text, ('inconclusive'::character varying)::text])`),
	check("ck_experiment_interpretations_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('reviewed'::character varying)::text, ('converted'::character varying)::text])`),
	check("ck_experiment_interpretations_run_ids_array", sql`jsonb_typeof(run_ids_json) = 'array'::text`),
	check("ck_experiment_interpretations_converted_has_signal", sql`(status)::text <> 'converted'::text OR resulting_signal_id IS NOT NULL`),
]);
