import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, jsonb, boolean, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { runs } from "./runs";
import { artifacts } from "./artifacts";
import { projects } from "./projects";
import { spaces } from "./spaces";
import { spaceObjects } from "./knowledge";
import { claims } from "./knowledge";
import { projectOperations } from "./projectOperations";
import { inquiryThreads } from "./inquiry";
import { projectResearchContextVersions } from "./projectResearchContext";
import { sourceItems } from "./sources";

// Project-owned Research workflow foundation. Runs/Artifacts/
// Proposals keep their existing authority boundaries — these tables only
// track workflow state, human checkpoints, and which Artifacts belong to
// which workflow stage.

export const projectResearchWorkflows = pgTable("project_research_workflows", {
	// Ontology aggregate root. Identity, visibility, Project scope,
	// provenance, title, and timestamps live on `space_objects`.
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	currentStage: varchar("current_stage", { length: 64 }),
	status: varchar({ length: 16 }).default('active').notNull(),
	stateJson: jsonb("state_json").default({}).notNull(),
	startedByUserId: varchar("started_by_user_id", { length: 36 }),
	startedRunId: varchar("started_run_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_research_workflows_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_research_workflows_project_status").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.status.asc().nullsLast()),
	unique("uq_project_research_workflows_id_space_id").on(table.objectId, table.spaceId),
	unique("uq_project_research_workflows_id_project_space").on(table.objectId, table.projectId, table.spaceId),
	foreignKey({
		columns: [table.objectId, table.spaceId],
		foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
		name: "project_research_workflows_object_id_fkey",
	}).onDelete("cascade"),
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
	check("ck_project_research_workflows_status", sql`(status)::text = ANY (ARRAY[('not_started'::character varying)::text, ('active'::character varying)::text, ('paused'::character varying)::text, ('completed'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_project_research_workflows_state_object", sql`jsonb_typeof(state_json) = 'object'::text`),
]);

// Durable, Thread-scoped conversation behind the dedicated research-question
// assessment workspace. The browser is only a projection of these rows:
// successful and failed user turns remain available across devices, while the
// latest structured framework is stored on the session for fast restoration.
export const projectResearchQuestionAssessmentSessions = pgTable("project_research_question_assessment_sessions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	recommendedQuestion: text("recommended_question"),
	latestRefinementJson: jsonb("latest_refinement_json"),
	assessmentBaselineJson: jsonb("assessment_baseline_json"),
	researchContextVersionId: varchar("research_context_version_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("uq_project_research_question_assessment_sessions_id_space").on(table.id, table.spaceId),
	uniqueIndex("uq_project_research_question_assessment_sessions_thread").using("btree", table.spaceId.asc().nullsLast(), table.threadId.asc().nullsLast()),
	index("ix_project_research_question_assessment_sessions_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.updatedAt.desc().nullsLast()),
	foreignKey({
		columns: [table.threadId, table.projectId, table.spaceId],
		foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
		name: "project_research_question_assessment_sessions_thread_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "project_research_question_assessment_sessions_project_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.researchContextVersionId, table.projectId, table.spaceId],
		foreignColumns: [projectResearchContextVersions.id, projectResearchContextVersions.projectId, projectResearchContextVersions.spaceId],
		name: "project_research_question_assessment_sessions_context_fkey"
	}),
	foreignKey({
		columns: [table.createdByUserId],
		foreignColumns: [users.id],
		name: "project_research_question_assessment_sessions_created_by_fkey"
	}),
	check("ck_project_research_question_assessment_sessions_refinement_object", sql`latest_refinement_json IS NULL OR jsonb_typeof(latest_refinement_json) = 'object'::text`),
	check("ck_project_research_question_assessment_sessions_baseline_object", sql`assessment_baseline_json IS NULL OR jsonb_typeof(assessment_baseline_json) = 'object'::text`),
]);

export const projectResearchQuestionAssessmentMessages = pgTable("project_research_question_assessment_messages", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	turnIndex: integer("turn_index").notNull(),
	role: varchar({ length: 16 }).notNull(),
	content: text().notNull(),
	status: varchar({ length: 16 }).default('complete').notNull(),
	structuredOutputJson: jsonb("structured_output_json"),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("uq_project_research_question_assessment_messages_turn_role").using("btree", table.sessionId.asc().nullsLast(), table.turnIndex.asc().nullsLast(), table.role.asc().nullsLast()),
	index("ix_project_research_question_assessment_messages_session").using("btree", table.spaceId.asc().nullsLast(), table.sessionId.asc().nullsLast(), table.turnIndex.asc().nullsLast()),
	foreignKey({
		columns: [table.sessionId, table.spaceId],
		foreignColumns: [projectResearchQuestionAssessmentSessions.id, projectResearchQuestionAssessmentSessions.spaceId],
		name: "project_research_question_assessment_messages_session_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.createdByUserId],
		foreignColumns: [users.id],
		name: "project_research_question_assessment_messages_created_by_fkey"
	}).onDelete("set null"),
	check("ck_project_research_question_assessment_messages_turn", sql`turn_index >= 1`),
	check("ck_project_research_question_assessment_messages_role", sql`role IN ('user', 'assistant')`),
	check("ck_project_research_question_assessment_messages_status", sql`status IN ('pending', 'complete', 'failed')`),
	check("ck_project_research_question_assessment_messages_content", sql`char_length(content) BETWEEN 1 AND 20000`),
	check("ck_project_research_question_assessment_messages_structured_object", sql`structured_output_json IS NULL OR jsonb_typeof(structured_output_json) = 'object'::text`),
]);

// Immutable outcomes of completed monitoring scans. Keeping this separate
// from workflow/operation projections means later re-screening cannot rewrite
// the historical "what was found on this scan" timeline.
export const researchScanSummaries = pgTable("research_scan_summaries", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	workflowId: varchar("workflow_id", { length: 36 }),
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
	uniqueIndex("uq_research_scan_summaries_workflow_scan").using("btree", table.spaceId.asc().nullsLast(), table.workflowId.asc().nullsLast(), table.scanKey.asc().nullsLast()).where(sql`workflow_id IS NOT NULL`),
	uniqueIndex("uq_research_scan_summaries_standing_scan").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.scanKey.asc().nullsLast()).where(sql`workflow_id IS NULL`),
	unique("uq_research_scan_summaries_id_space").on(table.id, table.spaceId),
	index("ix_research_scan_summaries_project_scanned_at").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.scannedAt.desc().nullsLast()),
	foreignKey({
		columns: [table.workflowId, table.spaceId],
		foreignColumns: [projectResearchWorkflows.objectId, projectResearchWorkflows.spaceId],
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

/** Durable accumulation window for workflow-free Project standing comparison. */
export const projectResearchStandingBatches = pgTable("project_research_standing_batches", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	status: varchar({ length: 32 }).default("pending").notNull(),
	sourceItemIdsJson: jsonb("source_item_ids_json").default([]).notNull(),
	windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "string" }).notNull(),
	readyAt: timestamp("ready_at", { withTimezone: true, mode: "string" }).notNull(),
	runId: varchar("run_id", { length: 36 }),
	missingBaselineRole: varchar("missing_baseline_role", { length: 32 }),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("uq_project_research_standing_batches_open_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()).where(sql`status = 'pending'`),
	unique("uq_project_research_standing_batches_id_space").on(table.id, table.spaceId),
	index("ix_project_research_standing_batches_project_ready").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.readyAt.asc().nullsLast()),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "project_research_standing_batches_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.runId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "project_research_standing_batches_run_fkey" }),
	check("ck_project_research_standing_batches_status", sql`status IN ('pending','running','completed','blocked_baseline','budget_exhausted','failed')`),
	check("ck_project_research_standing_batches_items_array", sql`jsonb_typeof(source_item_ids_json) = 'array'`),
]);

/** User-facing suggestions produced by standing comparison and explicitly actioned by a user. */
export const projectResearchStandingAdvice = pgTable("project_research_standing_advice", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
	batchId: varchar("batch_id", { length: 36 }).notNull(),
	detail: text().notNull(),
	affectedSectionsJson: jsonb("affected_sections_json").default([]).notNull(),
	status: varchar({ length: 16 }).default("open").notNull(),
	actionId: varchar("action_id", { length: 128 }).notNull(),
	actionInputJson: jsonb("action_input_json").notNull(),
	idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
	createdByRunId: varchar("created_by_run_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("uq_project_research_standing_advice_project_source").on(table.spaceId, table.projectId, table.sourceItemId),
	unique("uq_project_research_standing_advice_idempotency").on(table.spaceId, table.idempotencyKey),
	index("ix_project_research_standing_advice_project_status").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "project_research_standing_advice_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.batchId, table.spaceId], foreignColumns: [projectResearchStandingBatches.id, projectResearchStandingBatches.spaceId], name: "project_research_standing_advice_batch_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.sourceItemId, table.spaceId], foreignColumns: [sourceItems.id, sourceItems.spaceId], name: "project_research_standing_advice_source_item_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.createdByRunId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "project_research_standing_advice_run_fkey" }),
	check("ck_project_research_standing_advice_status", sql`status IN ('open','actioned','dismissed')`),
	check("ck_project_research_standing_advice_sections_array", sql`jsonb_typeof(affected_sections_json) = 'array'`),
	check("ck_project_research_standing_advice_action_input_object", sql`jsonb_typeof(action_input_json) = 'object'`),
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
			foreignColumns: [projectResearchWorkflows.objectId, projectResearchWorkflows.spaceId],
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
	check("ck_project_research_checkpoints_checkpoint_type", sql`(checkpoint_type)::text = ANY (ARRAY[('screening_gate'::character varying)::text, ('idea_review'::character varying)::text, ('integrity_gate'::character varying)::text, ('manuscript_gate'::character varying)::text, ('review_gate'::character varying)::text, ('other'::character varying)::text])`),
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
	evidenceMatrixArtifactId: varchar("evidence_matrix_artifact_id", { length: 36 }),
	integrityArtifactId: varchar("integrity_artifact_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("uq_project_research_reports_synthesis_run").using("btree", table.spaceId.asc().nullsLast(), table.synthesisRunId.asc().nullsLast()),
	index("ix_project_research_reports_project_created").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.createdAt.desc().nullsLast()),
	index("ix_project_research_reports_workflow").using("btree", table.workflowId.asc().nullsLast()),
	foreignKey({
		columns: [table.workflowId, table.spaceId],
		foreignColumns: [projectResearchWorkflows.objectId, projectResearchWorkflows.spaceId],
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
	foreignKey({ columns: [table.evidenceMatrixArtifactId, table.spaceId], foreignColumns: [artifacts.id, artifacts.spaceId], name: "project_research_reports_matrix_artifact_id_fkey" }),
	foreignKey({ columns: [table.integrityArtifactId, table.spaceId], foreignColumns: [artifacts.id, artifacts.spaceId], name: "project_research_reports_integrity_artifact_id_fkey" }),
	check("ck_project_research_reports_run_kind", sql`run_kind IN ('baseline', 'historical_backfill', 'incremental', 'question_rescreen', 'synthesis_only')`),
	check("ck_project_research_reports_status", sql`status IN ('awaiting_review', 'complete', 'rejected')`),
	check("ck_project_research_reports_question_version", sql`research_question_version >= 1`),
	check("ck_project_research_reports_content_object", sql`jsonb_typeof(content_json) = 'object'::text`),
	check("ck_project_research_reports_reader_object", sql`jsonb_typeof(reader_document_json) = 'object'::text`),
]);

// Project-owned screening criteria (include/exclude keywords,
// profile-declared domain criteria, date range, source restrictions,
// required evidence fields) used
// to focus material triage. One row per project; AI screening suggestions and
// the corpus/matrix read models consume this, but project_corpus_items.
// triage_status (gated by triage_confirmed_by_user) remains the durable,
// user-confirmed source of truth — this table never itself marks material
// included/excluded.
export const projectResearchScreeningCriteria = pgTable("project_research_screening_criteria", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	includeKeywordsJson: jsonb("include_keywords_json").default([]).notNull(),
	excludeKeywordsJson: jsonb("exclude_keywords_json").default([]).notNull(),
	// Domain-specific screening axes, keyed by what the bound extraction profile
	// declares (R4/D12). `methods` was a column, which forced every domain to
	// carry an irrelevant domain-shaped criterion; an unconstrained bag would have been the
	// opposite mistake, so the legal keys come from the profile registry and the
	// column only guarantees the shape.
	domainCriteriaJson: jsonb("domain_criteria_json").default({}).notNull(),
	dateRangeStart: timestamp("date_range_start", { withTimezone: true, mode: 'string' }),
	dateRangeEnd: timestamp("date_range_end", { withTimezone: true, mode: 'string' }),
	// Journals, outlets and sites are the same concept: where material may come
	// from. `venues` named only the academic half of it.
	sourceRestrictionsJson: jsonb("source_restrictions_json").default([]).notNull(),
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
	check("ck_project_research_screening_criteria_domain_criteria_object", sql`jsonb_typeof(domain_criteria_json) = 'object'::text`),
	check("ck_project_research_screening_criteria_source_restrictions_array", sql`jsonb_typeof(source_restrictions_json) = 'array'::text`),
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
			foreignColumns: [projectResearchWorkflows.objectId],
			name: "project_research_claim_links_workflow_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.workflowId, table.spaceId],
			foreignColumns: [projectResearchWorkflows.objectId, projectResearchWorkflows.spaceId],
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
