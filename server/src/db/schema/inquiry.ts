import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, jsonb, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { notes } from "./knowledge";

// Inquiry Domain (plan section 9 / ADR 0011). InquiryThread is a
// Project-owned root table, never a `space_objects` row — see ADR 0011
// decision 1. Business relationships use their own narrowly-owned link
// tables (B12A "narrowly owned domain join table" exception), never
// `object_relations`.

export const inquiryThreads = pgTable("inquiry_threads", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	kind: varchar({ length: 16 }).notNull(),
	statement: text().notNull(),
	lifecycleStatus: varchar("lifecycle_status", { length: 24 }).default('active').notNull(),
	attentionState: varchar("attention_state", { length: 16 }).default('backlog').notNull(),
	priority: integer().default(0).notNull(),
	primaryParentId: varchar("primary_parent_id", { length: 36 }),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	// Current Next Focus invariant (plan section 9.5): an active, focused
	// Thread has exactly one of nextFocusKind or blockedReason set.
	nextFocusKind: varchar("next_focus_kind", { length: 32 }),
	nextFocusNote: text("next_focus_note"),
	blockedReason: text("blocked_reason"),
	version: integer().default(1).notNull(),
	createdFrom: varchar("created_from", { length: 32 }).default('user').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_threads_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_inquiry_threads_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_inquiry_threads_primary_parent_id").using("btree", table.primaryParentId.asc().nullsLast()),
	index("ix_inquiry_threads_attention_state").using("btree", table.projectId.asc().nullsLast(), table.attentionState.asc().nullsLast()),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_threads_space_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_threads_space_id_fkey"
		}),
	// No ON DELETE SET NULL here: a composite FK that includes `space_id`
	// must never SET NULL (space_id is NOT NULL, and this repo's tenant
	// reference integrity test forbids any SET NULL FK on the tenant column).
	// Clearing `primary_parent_id` is an explicit `setPrimaryParent(null)` app
	// action, not an implicit consequence of deleting the parent Thread.
	foreignKey({
			columns: [table.primaryParentId, table.projectId, table.spaceId],
			foreignColumns: [table.id, table.projectId, table.spaceId],
			name: "inquiry_threads_primary_parent_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "inquiry_threads_owner_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "inquiry_threads_created_by_user_id_fkey"
		}).onDelete("set null"),
	unique("uq_inquiry_threads_space_id_id").on(table.id, table.spaceId),
	unique("uq_inquiry_threads_id_project_space").on(table.id, table.projectId, table.spaceId),
	check("ck_inquiry_threads_kind", sql`(kind)::text = ANY (ARRAY[('question'::character varying)::text, ('hypothesis'::character varying)::text])`),
	check("ck_inquiry_threads_lifecycle_status", sql`(lifecycle_status)::text = ANY (ARRAY[('active'::character varying)::text, ('resolved'::character varying)::text, ('rejected'::character varying)::text, ('superseded'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_inquiry_threads_attention_state", sql`(attention_state)::text = ANY (ARRAY[('focused'::character varying)::text, ('monitoring'::character varying)::text, ('backlog'::character varying)::text, ('blocked'::character varying)::text, ('resolved'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_inquiry_threads_created_from", sql`(created_from)::text = ANY (ARRAY[('user'::character varying)::text, ('ai_candidate'::character varying)::text, ('decomposition'::character varying)::text])`),
	check("ck_inquiry_threads_focused_next_focus", sql`attention_state <> 'focused' OR ((next_focus_kind IS NULL) <> (blocked_reason IS NULL))`),
	check("ck_inquiry_threads_lifecycle_attention", sql`
		(lifecycle_status = 'active' AND attention_state IN ('focused', 'monitoring', 'backlog', 'blocked'))
		OR (lifecycle_status = 'resolved' AND attention_state = 'resolved')
		OR (lifecycle_status = 'rejected' AND attention_state = 'rejected')
		OR (lifecycle_status IN ('superseded', 'archived') AND attention_state = 'archived')
	`),
]);

export const inquiryQuestionStates = pgTable("inquiry_question_states", {
	threadId: varchar("thread_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	currentAnswerSummary: text("current_answer_summary"),
	answerState: varchar("answer_state", { length: 16 }).default('open').notNull(),
	knownGaps: text("known_gaps"),
	answerability: text(),
	resolutionCriteria: text("resolution_criteria"),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.threadId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.spaceId],
			name: "inquiry_question_states_thread_fkey"
		}).onDelete("cascade"),
	check("ck_inquiry_question_states_answer_state", sql`(answer_state)::text = ANY (ARRAY[('open'::character varying)::text, ('partial'::character varying)::text, ('answered'::character varying)::text, ('unanswerable'::character varying)::text])`),
]);

export const inquiryHypothesisStates = pgTable("inquiry_hypothesis_states", {
	threadId: varchar("thread_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	proposedClaim: text("proposed_claim"),
	predictions: text(),
	falsificationCriteria: text("falsification_criteria"),
	evaluationState: varchar("evaluation_state", { length: 16 }).default('untested').notNull(),
	confidence: integer(),
	confidenceMethod: varchar("confidence_method", { length: 32 }),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.threadId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.spaceId],
			name: "inquiry_hypothesis_states_thread_fkey"
		}).onDelete("cascade"),
	check("ck_inquiry_hypothesis_states_evaluation_state", sql`(evaluation_state)::text = ANY (ARRAY[('untested'::character varying)::text, ('supported'::character varying)::text, ('challenged'::character varying)::text, ('contradicted'::character varying)::text, ('inconclusive'::character varying)::text])`),
	check("ck_inquiry_hypothesis_states_confidence", sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 100)`),
]);

// Working relationship graph between Threads (plan section 9.3). Distinct
// from `object_relations` by construction: Threads are not `space_objects`
// rows, so this table cannot and does not share that graph.
export const inquiryThreadRelations = pgTable("inquiry_thread_relations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	fromThreadId: varchar("from_thread_id", { length: 36 }).notNull(),
	toThreadId: varchar("to_thread_id", { length: 36 }).notNull(),
	relationKind: varchar("relation_kind", { length: 24 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_thread_relations_from").using("btree", table.fromThreadId.asc().nullsLast()),
	index("ix_inquiry_thread_relations_to").using("btree", table.toThreadId.asc().nullsLast()),
	uniqueIndex("uq_inquiry_thread_relations_edge").using("btree", table.fromThreadId.asc().nullsLast(), table.toThreadId.asc().nullsLast(), table.relationKind.asc().nullsLast()),
	foreignKey({
			columns: [table.fromThreadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_relations_from_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.toThreadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_relations_to_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_thread_relations_space_id_fkey"
		}),
	check("ck_inquiry_thread_relations_kind", sql`(relation_kind)::text = ANY (ARRAY[('decomposes_into'::character varying)::text, ('proposes'::character varying)::text, ('depends_on'::character varying)::text, ('supports'::character varying)::text, ('contradicts'::character varying)::text, ('supersedes'::character varying)::text, ('related_to'::character varying)::text])`),
	check("ck_inquiry_thread_relations_no_self_edge", sql`from_thread_id <> to_thread_id`),
]);

// Material statement changes (plan section 9.4 "Thread definition"). Wording-
// only edits update `inquiry_threads.statement` in place; semantic changes
// additionally record which structural action the user chose.
export const inquiryThreadStatementRevisions = pgTable("inquiry_thread_statement_revisions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	revisionKind: varchar("revision_kind", { length: 16 }).notNull(),
	previousStatement: text("previous_statement").notNull(),
	newStatement: text("new_statement").notNull(),
	structureAction: varchar("structure_action", { length: 16 }),
	impactNote: text("impact_note"),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_thread_statement_revisions_thread_id").using("btree", table.threadId.asc().nullsLast(), table.createdAt.desc()),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_statement_revisions_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_thread_statement_revisions_space_id_fkey"
		}),
	check("ck_inquiry_thread_statement_revisions_kind", sql`(revision_kind)::text = ANY (ARRAY[('wording_only'::character varying)::text, ('semantic_change'::character varying)::text])`),
	check("ck_inquiry_thread_statement_revisions_structure_action", sql`structure_action IS NULL OR (structure_action)::text = ANY (ARRAY[('narrow'::character varying)::text, ('child'::character varying)::text, ('supersede'::character varying)::text])`),
]);

// Immutable full-content snapshot per cognitively-meaningful Thread change
// Unlike inquiry_thread_statement_revisions above (statement
// text only, no hash, no version number), this captures everything a
// Knowledge Candidate's pinned `inquiry_thread_revision` source reference
// needs to resolve back to the exact promoted state — statement plus
// Question/Hypothesis cognitive state — and is written from exactly two
// places: iterationService.ts's reviseDefinition (statement changes) and
// recordIteration (cognitive-state changes). `changeSignificance` is the
// non-LLM staleness signal the revalidation worker keys off: a
// wording_only definition revision is 'trivial'; a semantic_change
// revision or any recorded Iteration is 'material'.
export const inquiryThreadRevisions = pgTable("inquiry_thread_revisions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	version: integer().notNull(),
	kind: varchar({ length: 16 }).notNull(),
	statement: text().notNull(),
	answerState: varchar("answer_state", { length: 16 }),
	evaluationState: varchar("evaluation_state", { length: 16 }),
	confidence: integer(),
	stateSnapshotJson: jsonb("state_snapshot_json").notNull(),
	contentHash: varchar("content_hash", { length: 64 }).notNull(),
	changeSignificance: varchar("change_significance", { length: 16 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_thread_revisions_thread_id").using("btree", table.threadId.asc().nullsLast(), table.version.desc()),
	uniqueIndex("uq_inquiry_thread_revisions_thread_version").using("btree", table.threadId.asc().nullsLast(), table.version.asc().nullsLast()),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_revisions_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_thread_revisions_space_id_fkey"
		}),
	check("ck_inquiry_thread_revisions_kind", sql`(kind)::text = ANY (ARRAY[('question'::character varying)::text, ('hypothesis'::character varying)::text])`),
	check("ck_inquiry_thread_revisions_significance", sql`(change_significance)::text = ANY (ARRAY[('trivial'::character varying)::text, ('material'::character varying)::text])`),
]);

export const inquiryThreadLifecycleEvents = pgTable("inquiry_thread_lifecycle_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	fromStatus: varchar("from_status", { length: 24 }).notNull(),
	toStatus: varchar("to_status", { length: 24 }).notNull(),
	reason: text(),
	actorUserId: varchar("actor_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_thread_lifecycle_events_thread_id").using("btree", table.threadId.asc().nullsLast(), table.createdAt.desc()),
	foreignKey({
		columns: [table.threadId, table.projectId, table.spaceId],
		foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
		name: "inquiry_thread_lifecycle_events_thread_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "inquiry_thread_lifecycle_events_project_fkey"
	}).onDelete("cascade"),
]);

export const inquiryThreadStructureEvents = pgTable("inquiry_thread_structure_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	actionKind: varchar("action_kind", { length: 32 }).notNull(),
	fromValueJson: jsonb("from_value_json"),
	toValueJson: jsonb("to_value_json"),
	actorUserId: varchar("actor_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_thread_structure_events_thread_id").using("btree", table.threadId.asc().nullsLast(), table.createdAt.desc()),
	foreignKey({
		columns: [table.threadId, table.projectId, table.spaceId],
		foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
		name: "inquiry_thread_structure_events_thread_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "inquiry_thread_structure_events_project_fkey"
	}).onDelete("cascade"),
	check("ck_inquiry_thread_structure_events_action", sql`(action_kind)::text = ANY (ARRAY[('relation_added'::character varying)::text, ('relation_removed'::character varying)::text, ('primary_parent_changed'::character varying)::text, ('definition_child_created'::character varying)::text, ('definition_superseded'::character varying)::text])`),
]);

// The confirmed cognitive-progress record (plan section 9.4). Thread stores
// the current projection; Iteration stores why it became current.
export const inquiryIterations = pgTable("inquiry_iterations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	triggerKind: varchar("trigger_kind", { length: 32 }).default('user_edit').notNull(),
	triggerRef: varchar("trigger_ref", { length: 128 }),
	inputRefsJson: jsonb("input_refs_json").default([]).notNull(),
	previousPositionJson: jsonb("previous_position_json").notNull(),
	newPositionJson: jsonb("new_position_json").notNull(),
	confidenceDelta: integer("confidence_delta"),
	changeSummary: text("change_summary").notNull(),
	reasoningSummary: text("reasoning_summary"),
	unresolvedGaps: text("unresolved_gaps"),
	confirmedNextFocus: varchar("confirmed_next_focus", { length: 32 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByRunId: varchar("created_by_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_iterations_thread_id").using("btree", table.threadId.asc().nullsLast(), table.createdAt.desc()),
	index("ix_inquiry_iterations_project_id").using("btree", table.projectId.asc().nullsLast()),
	unique("uq_inquiry_iterations_id_project_space").on(table.id, table.projectId, table.spaceId),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_iterations_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_iterations_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_iterations_space_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByRunId],
			foreignColumns: [runs.id],
			name: "inquiry_iterations_created_by_run_id_fkey"
		}).onDelete("set null"),
]);

// Audited, non-cognitive work-management history (plan section 9.4 "Work
// management"): priority, owner, focus membership, Next Focus, blocking
// reason. Never creates an Iteration.
export const inquiryThreadWorkEvents = pgTable("inquiry_thread_work_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	actionKind: varchar("action_kind", { length: 32 }).notNull(),
	fromValue: text("from_value"),
	toValue: text("to_value"),
	actorUserId: varchar("actor_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_thread_work_events_thread_id").using("btree", table.threadId.asc().nullsLast(), table.createdAt.desc()),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_work_events_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_thread_work_events_space_id_fkey"
		}),
]);

// Deep writing uses the unified Note model (plan section 9.7); this is the
// explicit FK link table, not a copy of Note content.
export const inquiryThreadNoteLinks = pgTable("inquiry_thread_note_links", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	noteObjectId: varchar("note_object_id", { length: 36 }).notNull(),
	linkKind: varchar("link_kind", { length: 24 }).default('linked_note').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_thread_note_links_thread_id").using("btree", table.threadId.asc().nullsLast()),
	uniqueIndex("uq_inquiry_thread_note_links_thread_note").using("btree", table.threadId.asc().nullsLast(), table.noteObjectId.asc().nullsLast()),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_note_links_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.noteObjectId, table.spaceId],
			foreignColumns: [notes.objectId, notes.spaceId],
			name: "inquiry_thread_note_links_note_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_thread_note_links_space_id_fkey"
		}),
	check("ck_inquiry_thread_note_links_kind", sql`(link_kind)::text = ANY (ARRAY[('primary_working_note'::character varying)::text, ('linked_note'::character varying)::text])`),
]);

// Personal Focus (plan section 9.6): each member's own working set, separate
// from the Shared Project Focus Set (`inquiry_threads.attention_state='focused'`).
export const inquiryThreadPersonalFocus = pgTable("inquiry_thread_personal_focus", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("uq_inquiry_thread_personal_focus_scope").using("btree", table.userId.asc().nullsLast(), table.threadId.asc().nullsLast()),
	index("ix_inquiry_thread_personal_focus_project_id").using("btree", table.projectId.asc().nullsLast(), table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_personal_focus_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_thread_personal_focus_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_thread_personal_focus_space_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "inquiry_thread_personal_focus_user_id_fkey"
		}).onDelete("cascade"),
]);

// Project-configurable shared Focus WIP limit (plan section 9.6). One row
// per Project, created lazily; a missing row means the default (3) applies.
export const inquiryProjectSettings = pgTable("inquiry_project_settings", {
	projectId: varchar("project_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sharedFocusWipLimit: integer("shared_focus_wip_limit").default(3).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_project_settings_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_project_settings_space_id_fkey"
		}),
	check("ck_inquiry_project_settings_wip_limit", sql`shared_focus_wip_limit >= 1`),
]);
