import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, jsonb, doublePrecision, boolean, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { projectCorpusItems } from "./projectCorpus";
import { inquiryIterations, inquiryThreads } from "./inquiry";
import { experimentInterpretations } from "./experiments";

// Signals, Candidates, Delta, and Review (plan section 10). Four levels:
// Raw Detection (not modeled — producers classify directly into a Signal) ->
// Evidence Signal -> Consolidated Candidate -> confirmed Iteration (via the
// existing InquiryIterationService) or new Thread.

export const inquiryEvidenceSignals = pgTable("inquiry_evidence_signals", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	// Exactly one Signal source is set (see ck_inquiry_evidence_signals_one_source):
	// a Corpus item, or a reviewed Experiment Interpretation
	// ("convert reviewed interpretations to Evidence Signals").
	corpusItemId: varchar("corpus_item_id", { length: 36 }),
	experimentInterpretationId: varchar("experiment_interpretation_id", { length: 36 }),
	classification: varchar({ length: 16 }).notNull(),
	// Routine signals may auto-attach; material signals must consolidate into
	// a Candidate for review (plan section 10.1-10.2).
	isMaterial: boolean("is_material").default(false).notNull(),
	confidence: doublePrecision(),
	modelVersion: varchar("model_version", { length: 64 }),
	sourceProvenanceJson: jsonb("source_provenance_json").default({}).notNull(),
	dedupeKey: varchar("dedupe_key", { length: 64 }).notNull(),
	producerIdempotencyKey: varchar("producer_idempotency_key", { length: 128 }),
	status: varchar({ length: 16 }).default('pending').notNull(),
	candidateId: varchar("candidate_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByRunId: varchar("created_by_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_evidence_signals_thread_id").using("btree", table.threadId.asc().nullsLast(), table.createdAt.desc()),
	index("ix_inquiry_evidence_signals_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_inquiry_evidence_signals_candidate_id").using("btree", table.candidateId.asc().nullsLast()),
	index("ix_inquiry_evidence_signals_corpus_item_id").using("btree", table.corpusItemId.asc().nullsLast()),
	uniqueIndex("uq_inquiry_evidence_signals_dedupe").using("btree", table.projectId.asc().nullsLast(), table.dedupeKey.asc().nullsLast()),
	uniqueIndex("uq_inquiry_evidence_signals_producer_key").using("btree", table.projectId.asc().nullsLast(), table.producerIdempotencyKey.asc().nullsLast()).where(sql`producer_idempotency_key IS NOT NULL`),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_evidence_signals_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_evidence_signals_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.corpusItemId, table.projectId, table.spaceId],
			foreignColumns: [projectCorpusItems.id, projectCorpusItems.projectId, projectCorpusItems.spaceId],
			name: "inquiry_evidence_signals_corpus_item_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.experimentInterpretationId, table.projectId, table.spaceId],
			foreignColumns: [experimentInterpretations.id, experimentInterpretations.projectId, experimentInterpretations.spaceId],
			name: "inquiry_evidence_signals_experiment_interpretation_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_evidence_signals_space_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByRunId],
			foreignColumns: [runs.id],
			name: "inquiry_evidence_signals_created_by_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.candidateId, table.projectId, table.spaceId],
			foreignColumns: [inquirySignalCandidates.id, inquirySignalCandidates.projectId, inquirySignalCandidates.spaceId],
			name: "inquiry_evidence_signals_candidate_fkey"
		}),
	check("ck_inquiry_evidence_signals_classification", sql`(classification)::text = ANY (ARRAY[('supports'::character varying)::text, ('contradicts'::character varying)::text, ('adds_context'::character varying)::text, ('adds_method'::character varying)::text, ('fills_gap'::character varying)::text, ('raises_gap'::character varying)::text, ('unrelated'::character varying)::text])`),
	check("ck_inquiry_evidence_signals_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('auto_attached'::character varying)::text, ('consolidated'::character varying)::text, ('dismissed'::character varying)::text])`),
	check("ck_inquiry_evidence_signals_confidence", sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`),
	check("ck_inquiry_evidence_signals_one_source", sql`(corpus_item_id IS NOT NULL) <> (experiment_interpretation_id IS NOT NULL)`),
]);

// Consolidated Candidate: the only thing that reaches human review (plan
// section 10.2). Deduplicates/merges multiple Signals about the same
// material change into one explainable unit.
export const inquirySignalCandidates = pgTable("inquiry_signal_candidates", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	candidateKind: varchar("candidate_kind", { length: 32 }).notNull(),
	semanticKey: varchar("semantic_key", { length: 128 }).notNull(),
	title: text().notNull(),
	summary: text(),
	proposedChangeJson: jsonb("proposed_change_json").default({}).notNull(),
	status: varchar({ length: 16 }).default('pending').notNull(),
	reviewPacketId: varchar("review_packet_id", { length: 36 }),
	resultingIterationId: varchar("resulting_iteration_id", { length: 36 }),
	resultingThreadId: varchar("resulting_thread_id", { length: 36 }),
	mergedIntoCandidateId: varchar("merged_into_candidate_id", { length: 36 }),
	decisionReason: text("decision_reason"),
	deferUntil: timestamp("defer_until", { withTimezone: true, mode: 'string' }),
	decidedByUserId: varchar("decided_by_user_id", { length: 36 }),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_signal_candidates_project_status").using("btree", table.projectId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_inquiry_signal_candidates_thread_id").using("btree", table.threadId.asc().nullsLast()),
	index("ix_inquiry_signal_candidates_review_packet_id").using("btree", table.reviewPacketId.asc().nullsLast()),
	unique("uq_inquiry_signal_candidates_id_project_space").on(table.id, table.projectId, table.spaceId),
	// One open (pending) Candidate per (thread, candidate_kind): the
	// mechanism behind "a contradiction produces one explainable Candidate."
	uniqueIndex("uq_inquiry_signal_candidates_open_semantic").using("btree", table.threadId.asc().nullsLast(), table.candidateKind.asc().nullsLast(), table.semanticKey.asc().nullsLast()).where(sql`(status)::text = 'pending'::text`),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_signal_candidates_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_signal_candidates_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_signal_candidates_space_id_fkey"
		}),
	foreignKey({
			columns: [table.decidedByUserId],
			foreignColumns: [users.id],
			name: "inquiry_signal_candidates_decided_by_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.reviewPacketId, table.projectId, table.spaceId],
			foreignColumns: [inquiryReviewPackets.id, inquiryReviewPackets.projectId, inquiryReviewPackets.spaceId],
			name: "inquiry_signal_candidates_review_packet_fkey"
		}),
	foreignKey({
			columns: [table.resultingIterationId, table.projectId, table.spaceId],
			foreignColumns: [inquiryIterations.id, inquiryIterations.projectId, inquiryIterations.spaceId],
			name: "inquiry_signal_candidates_iteration_fkey"
		}),
	foreignKey({
			columns: [table.resultingThreadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_signal_candidates_result_thread_fkey"
		}),
	foreignKey({
			columns: [table.mergedIntoCandidateId, table.projectId, table.spaceId],
			foreignColumns: [table.id, table.projectId, table.spaceId],
			name: "inquiry_signal_candidates_merge_target_fkey"
		}),
	check("ck_inquiry_signal_candidates_kind", sql`(candidate_kind)::text = ANY (ARRAY[('new_thread'::character varying)::text, ('contradiction'::character varying)::text, ('confidence_tier_crossing'::character varying)::text, ('state_change'::character varying)::text, ('next_focus_replacement'::character varying)::text, ('scope_change'::character varying)::text, ('knowledge_promotion_ready'::character varying)::text])`),
	check("ck_inquiry_signal_candidates_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('merged'::character varying)::text, ('deferred'::character varying)::text, ('dismissed'::character varying)::text, ('gap'::character varying)::text])`),
]);

// Bounded review round (plan section 10.4): a fixed small set of Candidates,
// not an endlessly growing inbox.
export const inquiryReviewPackets = pgTable("inquiry_review_packets", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	status: varchar({ length: 16 }).default('open').notNull(),
	openedByUserId: varchar("opened_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_review_packets_project_status").using("btree", table.projectId.asc().nullsLast(), table.status.asc().nullsLast()),
	unique("uq_inquiry_review_packets_id_project_space").on(table.id, table.projectId, table.spaceId),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_review_packets_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_review_packets_space_id_fkey"
		}),
	check("ck_inquiry_review_packets_status", sql`(status)::text = ANY (ARRAY[('open'::character varying)::text, ('closed'::character varying)::text])`),
]);

// Cited change summary (plan section 10.3). Read-only: it cannot change
// Thread position, confidence tier, status, or Next Focus.
export const inquiryDeltaBriefs = pgTable("inquiry_delta_briefs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	coverageStart: timestamp("coverage_start", { withTimezone: true, mode: 'string' }),
	coverageEnd: timestamp("coverage_end", { withTimezone: true, mode: 'string' }).notNull(),
	contentJson: jsonb("content_json").notNull(),
	generatedByUserId: varchar("generated_by_user_id", { length: 36 }),
	generatedByRunId: varchar("generated_by_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_delta_briefs_project_id").using("btree", table.projectId.asc().nullsLast(), table.createdAt.desc()),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_delta_briefs_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_delta_briefs_space_id_fkey"
		}),
	foreignKey({
			columns: [table.generatedByRunId],
			foreignColumns: [runs.id],
			name: "inquiry_delta_briefs_generated_by_run_id_fkey"
		}).onDelete("set null"),
]);
