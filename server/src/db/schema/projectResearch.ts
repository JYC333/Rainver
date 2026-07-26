import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, jsonb, boolean, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { runs } from "./runs";
import { artifacts } from "./artifacts";
import { projects } from "./projects";
import { spaces } from "./spaces";
import { claims } from "./knowledge";
import { projectOperations } from "./projectOperations";

// Project-owned Academic Research workflow foundation. Runs/Artifacts/
// Proposals keep their existing authority boundaries — these tables only
// track workflow state, human checkpoints, and which Artifacts belong to
// which workflow stage.

export const projectResearchProfiles = pgTable("project_research_profiles", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	presetKey: varchar("preset_key", { length: 64 }).default('academic_research').notNull(),
	researchQuestion: text("research_question"),
	workingTitle: varchar("working_title", { length: 512 }),
	domain: varchar({ length: 128 }),
	outputType: varchar("output_type", { length: 32 }),
	paperType: varchar("paper_type", { length: 32 }),
	citationStyle: varchar("citation_style", { length: 32 }),
	targetVenue: varchar("target_venue", { length: 256 }),
	language: varchar({ length: 16 }).default('en').notNull(),
	experimentIntakeDeclaration: varchar("experiment_intake_declaration", { length: 32 }).default('undecided').notNull(),
	status: varchar({ length: 16 }).default('draft').notNull(),
	approvedByUserId: varchar("approved_by_user_id", { length: 36 }),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_research_profiles_space_id").using("btree", table.spaceId.asc().nullsLast()),
	uniqueIndex("uq_project_research_profiles_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_research_profiles_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_research_profiles_space_id_fkey"
		}),
	foreignKey({
			columns: [table.approvedByUserId],
			foreignColumns: [users.id],
			name: "project_research_profiles_approved_by_user_id_fkey"
		}).onDelete("set null"),
	check("ck_project_research_profiles_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('approved'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_project_research_profiles_output_type", sql`(output_type IS NULL) OR ((output_type)::text = ANY (ARRAY[('paper'::character varying)::text, ('thesis'::character varying)::text, ('report'::character varying)::text, ('review'::character varying)::text, ('proposal'::character varying)::text, ('other'::character varying)::text]))`),
	check("ck_project_research_profiles_paper_type", sql`(paper_type IS NULL) OR ((paper_type)::text = ANY (ARRAY[('empirical'::character varying)::text, ('theory'::character varying)::text, ('survey'::character varying)::text, ('review'::character varying)::text, ('position'::character varying)::text, ('case_study'::character varying)::text, ('other'::character varying)::text]))`),
	check("ck_project_research_profiles_citation_style", sql`(citation_style IS NULL) OR ((citation_style)::text = ANY (ARRAY[('apa'::character varying)::text, ('mla'::character varying)::text, ('chicago'::character varying)::text, ('ieee'::character varying)::text, ('acm'::character varying)::text, ('vancouver'::character varying)::text, ('other'::character varying)::text]))`),
	check("ck_project_research_profiles_experiment_intake", sql`(experiment_intake_declaration)::text = ANY (ARRAY[('none'::character varying)::text, ('code_experiments'::character varying)::text, ('human_study'::character varying)::text, ('both'::character varying)::text, ('undecided'::character varying)::text])`),
]);

export const projectResearchWorkflows = pgTable("project_research_workflows", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	workflowType: varchar("workflow_type", { length: 32 }).notNull(),
	currentStage: varchar("current_stage", { length: 64 }),
	status: varchar({ length: 16 }).default('active').notNull(),
	mode: varchar({ length: 16 }).default('manual').notNull(),
	stateJson: jsonb("state_json").default({}).notNull(),
	startedByUserId: varchar("started_by_user_id", { length: 36 }),
	startedRunId: varchar("started_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_research_workflows_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_research_workflows_project_status").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.status.asc().nullsLast()),
	unique("uq_project_research_workflows_id_space_id").on(table.id, table.spaceId),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_research_workflows_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_research_workflows_space_id_fkey"
		}),
	foreignKey({
			columns: [table.startedByUserId],
			foreignColumns: [users.id],
			name: "project_research_workflows_started_by_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.startedRunId],
			foreignColumns: [runs.id],
			name: "project_research_workflows_started_run_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.startedRunId, table.spaceId],
			foreignColumns: [runs.id, runs.spaceId],
			name: "project_research_workflows_started_run_id_fkey"
		}),
	check("ck_project_research_workflows_workflow_type", sql`(workflow_type)::text = ANY (ARRAY[('literature_review'::character varying)::text, ('empirical_paper'::character varying)::text, ('theory_paper'::character varying)::text, ('paper_review'::character varying)::text, ('revision'::character varying)::text])`),
	check("ck_project_research_workflows_status", sql`(status)::text = ANY (ARRAY[('not_started'::character varying)::text, ('active'::character varying)::text, ('paused'::character varying)::text, ('completed'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_project_research_workflows_mode", sql`(mode)::text = ANY (ARRAY[('manual'::character varying)::text, ('agent_assisted'::character varying)::text, ('autonomous'::character varying)::text])`),
	check("ck_project_research_workflows_state_object", sql`jsonb_typeof(state_json) = 'object'::text`),
]);

// Immutable outcomes of completed monitoring scans. Keeping this separate
// from workflow/operation projections means later re-screening cannot rewrite
// the historical "what was found on this scan" timeline.
export const researchScanSummaries = pgTable("research_scan_summaries", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	workflowId: varchar("workflow_id", { length: 36 }).notNull(),
	operationId: varchar("operation_id", { length: 36 }),
	scanKey: varchar("scan_key", { length: 256 }).notNull(),
	scanWindowStart: timestamp("scan_window_start", { withTimezone: true, mode: 'string' }),
	scanWindowEnd: timestamp("scan_window_end", { withTimezone: true, mode: 'string' }),
	scannedAt: timestamp("scanned_at", { withTimezone: true, mode: 'string' }).notNull(),
	newItemCount: integer("new_item_count").default(0).notNull(),
	relevantCount: integer("relevant_count").default(0).notNull(),
	maybeCount: integer("maybe_count").default(0).notNull(),
	excludedCount: integer("excluded_count").default(0).notNull(),
	supportsCount: integer("supports_count").default(0).notNull(),
	contradictsCount: integer("contradicts_count").default(0).notNull(),
	newDirectionCount: integer("new_direction_count").default(0).notNull(),
	comparisonsJson: jsonb("comparisons_json").default([]).notNull(),
	integrityAlertsJson: jsonb("integrity_alerts_json").default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("uq_research_scan_summaries_workflow_scan").using("btree", table.spaceId.asc().nullsLast(), table.workflowId.asc().nullsLast(), table.scanKey.asc().nullsLast()),
	unique("uq_research_scan_summaries_id_space").on(table.id, table.spaceId),
	index("ix_research_scan_summaries_project_scanned_at").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.scannedAt.desc().nullsLast()),
	foreignKey({
		columns: [table.workflowId, table.spaceId],
		foreignColumns: [projectResearchWorkflows.id, projectResearchWorkflows.spaceId],
		name: "research_scan_summaries_workflow_id_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "research_scan_summaries_project_id_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.operationId, table.spaceId],
		foreignColumns: [projectOperations.id, projectOperations.spaceId],
		name: "research_scan_summaries_operation_id_fkey"
	}),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "research_scan_summaries_space_id_fkey"
	}),
	check("ck_research_scan_summaries_nonnegative_counts", sql`new_item_count >= 0 AND relevant_count >= 0 AND maybe_count >= 0 AND excluded_count >= 0 AND supports_count >= 0 AND contradicts_count >= 0 AND new_direction_count >= 0`),
	check("ck_research_scan_summaries_comparisons_array", sql`jsonb_typeof(comparisons_json) = 'array'`),
	check("ck_research_scan_summaries_integrity_alerts_array", sql`jsonb_typeof(integrity_alerts_json) = 'array'`),
]);

export const projectResearchCheckpoints = pgTable("project_research_checkpoints", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	workflowId: varchar("workflow_id", { length: 36 }).notNull(),
	stageKey: varchar("stage_key", { length: 64 }).notNull(),
	checkpointType: varchar("checkpoint_type", { length: 32 }).notNull(),
	status: varchar({ length: 16 }).default('pending').notNull(),
	machineResultJson: jsonb("machine_result_json"),
	userDecision: varchar("user_decision", { length: 16 }),
	decisionReason: text("decision_reason"),
	decidedByUserId: varchar("decided_by_user_id", { length: 36 }),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_research_checkpoints_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_research_checkpoints_project_id").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	index("ix_project_research_checkpoints_workflow_stage").using("btree", table.spaceId.asc().nullsLast(), table.workflowId.asc().nullsLast(), table.stageKey.asc().nullsLast()),
	index("ix_project_research_checkpoints_status").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.workflowId, table.spaceId],
			foreignColumns: [projectResearchWorkflows.id, projectResearchWorkflows.spaceId],
			name: "project_research_checkpoints_workflow_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_research_checkpoints_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_research_checkpoints_space_id_fkey"
		}),
	foreignKey({
			columns: [table.decidedByUserId],
			foreignColumns: [users.id],
			name: "project_research_checkpoints_decided_by_user_id_fkey"
		}).onDelete("set null"),
	check("ck_project_research_checkpoints_checkpoint_type", sql`(checkpoint_type)::text = ANY (ARRAY[('profile_approval'::character varying)::text, ('screening_gate'::character varying)::text, ('idea_review'::character varying)::text, ('integrity_gate'::character varying)::text, ('manuscript_gate'::character varying)::text, ('review_gate'::character varying)::text, ('other'::character varying)::text])`),
	check("ck_project_research_checkpoints_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('waived'::character varying)::text])`),
	check("ck_project_research_checkpoints_user_decision", sql`(user_decision IS NULL) OR ((user_decision)::text = ANY (ARRAY[('approved'::character varying)::text, ('rejected'::character varying)::text, ('waived'::character varying)::text]))`),
]);

export const projectResearchReports = pgTable("project_research_reports", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	workflowId: varchar("workflow_id", { length: 36 }).notNull(),
	operationId: varchar("operation_id", { length: 36 }).notNull(),
	synthesisRunId: varchar("synthesis_run_id", { length: 36 }).notNull(),
	runKind: varchar("run_kind", { length: 32 }).notNull(),
	researchQuestion: text("research_question").notNull(),
	researchQuestionVersion: integer("research_question_version").notNull(),
	status: varchar({ length: 32 }).default('awaiting_review').notNull(),
	contentJson: jsonb("content_json").notNull(),
	readerDocumentJson: jsonb("reader_document_json").notNull(),
	normalizedText: text("normalized_text").notNull(),
	contentHash: varchar("content_hash", { length: 64 }).notNull(),
	archiveArtifactId: varchar("archive_artifact_id", { length: 36 }).notNull(),
	literatureMatrixArtifactId: varchar("literature_matrix_artifact_id", { length: 36 }),
	integrityArtifactId: varchar("integrity_artifact_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("uq_project_research_reports_synthesis_run").using("btree", table.spaceId.asc().nullsLast(), table.synthesisRunId.asc().nullsLast()),
	index("ix_project_research_reports_project_created").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.createdAt.desc().nullsLast()),
	index("ix_project_research_reports_workflow").using("btree", table.workflowId.asc().nullsLast()),
	foreignKey({
		columns: [table.workflowId, table.spaceId],
		foreignColumns: [projectResearchWorkflows.id, projectResearchWorkflows.spaceId],
		name: "project_research_reports_workflow_id_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.operationId, table.spaceId],
		foreignColumns: [projectOperations.id, projectOperations.spaceId],
		name: "project_research_reports_operation_id_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "project_research_reports_project_id_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.synthesisRunId, table.spaceId],
		foreignColumns: [runs.id, runs.spaceId],
		name: "project_research_reports_synthesis_run_id_fkey"
	}),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "project_research_reports_space_id_fkey"
	}),
	foreignKey({
		columns: [table.archiveArtifactId, table.spaceId], foreignColumns: [artifacts.id, artifacts.spaceId], name: "project_research_reports_archive_artifact_id_fkey"
	}),
	foreignKey({ columns: [table.literatureMatrixArtifactId, table.spaceId], foreignColumns: [artifacts.id, artifacts.spaceId], name: "project_research_reports_matrix_artifact_id_fkey" }),
	foreignKey({ columns: [table.integrityArtifactId, table.spaceId], foreignColumns: [artifacts.id, artifacts.spaceId], name: "project_research_reports_integrity_artifact_id_fkey" }),
	check("ck_project_research_reports_run_kind", sql`run_kind IN ('baseline', 'historical_backfill', 'incremental', 'question_rescreen', 'synthesis_only')`),
	check("ck_project_research_reports_status", sql`status IN ('awaiting_review', 'complete', 'rejected')`),
	check("ck_project_research_reports_question_version", sql`research_question_version >= 1`),
	check("ck_project_research_reports_content_object", sql`jsonb_typeof(content_json) = 'object'::text`),
	check("ck_project_research_reports_reader_object", sql`jsonb_typeof(reader_document_json) = 'object'::text`),
]);

// Project-owned screening criteria (include/exclude keywords,
// methods, date range, venues/source types, required evidence fields) used
// to focus paper triage. One row per project; AI screening suggestions and
// the corpus/matrix read models consume this, but project_corpus_items.
// triage_status (gated by triage_confirmed_by_user) remains the durable,
// user-confirmed source of truth — this table never itself marks a paper
// included/excluded.
export const projectResearchScreeningCriteria = pgTable("project_research_screening_criteria", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	includeKeywordsJson: jsonb("include_keywords_json").default([]).notNull(),
	excludeKeywordsJson: jsonb("exclude_keywords_json").default([]).notNull(),
	methodsJson: jsonb("methods_json").default([]).notNull(),
	dateRangeStart: timestamp("date_range_start", { withTimezone: true, mode: 'string' }),
	dateRangeEnd: timestamp("date_range_end", { withTimezone: true, mode: 'string' }),
	venuesJson: jsonb("venues_json").default([]).notNull(),
	requiredEvidenceFieldsJson: jsonb("required_evidence_fields_json").default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_research_screening_criteria_space_id").using("btree", table.spaceId.asc().nullsLast()),
	uniqueIndex("uq_project_research_screening_criteria_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_research_screening_criteria_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_research_screening_criteria_space_id_fkey"
		}),
	check("ck_project_research_screening_criteria_include_keywords_array", sql`jsonb_typeof(include_keywords_json) = 'array'::text`),
	check("ck_project_research_screening_criteria_exclude_keywords_array", sql`jsonb_typeof(exclude_keywords_json) = 'array'::text`),
	check("ck_project_research_screening_criteria_methods_array", sql`jsonb_typeof(methods_json) = 'array'::text`),
	check("ck_project_research_screening_criteria_venues_array", sql`jsonb_typeof(venues_json) = 'array'::text`),
	check("ck_project_research_screening_criteria_evidence_fields_array", sql`jsonb_typeof(required_evidence_fields_json) = 'array'::text`),
	check("ck_project_research_screening_criteria_date_range", sql`(date_range_start IS NULL) OR (date_range_end IS NULL) OR (date_range_start <= date_range_end)`),
]);

// Project-level claim intent records for the integrity gate. Claims
// themselves stay global and proposal-gated (see
// .agent/architecture/CLAIM_FACT_ATOM_MODEL.md) — this table never writes
// `claims` directly, it only links an already-canonical claim to this
// project's workflow with project-specific tracking (support status,
// planned experiment ids, citation anchors, unresolved-gap markers) that the
// integrity gate reads.
export const projectResearchClaimLinks = pgTable("project_research_claim_links", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	workflowId: varchar("workflow_id", { length: 36 }),
	claimId: varchar("claim_id", { length: 36 }).notNull(),
	supportStatus: varchar("support_status", { length: 32 }).default('unsupported').notNull(),
	plannedExperimentIdsJson: jsonb("planned_experiment_ids_json").default([]).notNull(),
	citationAnchorsJson: jsonb("citation_anchors_json").default([]).notNull(),
	unresolvedGap: boolean("unresolved_gap").default(false).notNull(),
	gapReason: text("gap_reason"),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_research_claim_links_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_research_claim_links_project_id").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	index("ix_project_research_claim_links_workflow_id").using("btree", table.workflowId.asc().nullsLast()),
	uniqueIndex("uq_project_research_claim_links_project_claim").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.claimId.asc().nullsLast()),
	foreignKey({
			columns: [table.claimId, table.spaceId],
			foreignColumns: [claims.objectId, claims.spaceId],
			name: "project_research_claim_links_claim_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_research_claim_links_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workflowId],
			foreignColumns: [projectResearchWorkflows.id],
			name: "project_research_claim_links_workflow_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.workflowId, table.spaceId],
			foreignColumns: [projectResearchWorkflows.id, projectResearchWorkflows.spaceId],
			name: "project_research_claim_links_workflow_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_research_claim_links_space_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "project_research_claim_links_created_by_user_id_fkey"
		}).onDelete("set null"),
	check("ck_project_research_claim_links_support_status", sql`(support_status)::text = ANY (ARRAY[('unsupported'::character varying)::text, ('supported'::character varying)::text, ('partial'::character varying)::text, ('gap_declared'::character varying)::text])`),
	check("ck_project_research_claim_links_planned_experiment_ids_array", sql`jsonb_typeof(planned_experiment_ids_json) = 'array'::text`),
	check("ck_project_research_claim_links_citation_anchors_array", sql`jsonb_typeof(citation_anchors_json) = 'array'::text`),
]);
