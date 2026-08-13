import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, jsonb, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { spaceObjects } from "./knowledge";

// Inquiry Domain (plan section 9 / ADR 0011). InquiryThread is a
// Project-owned root table, never a `space_objects` row — see ADR 0011
// decision 1. Business relationships use their own narrowly-owned link
// tables (B12A "narrowly owned domain join table" exception), never
// `object_relations`.

export const inquiryThreads = pgTable("inquiry_threads", {
	// Ontology object (ADR 0012 / ADR 0011 decision 1). Identity, visibility,
	// ownership, provenance, and timestamps live on `space_objects`; what stays
	// here is what only Inquiry reads. `project_id` stays because ten sibling
	// tables key their tenant-integrity FKs on (thread, project, space).
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	kind: varchar({ length: 16 }).notNull(),
	statement: text().notNull(),
	lifecycleStatus: varchar("lifecycle_status", { length: 24 }).default('active').notNull(),
	attentionState: varchar("attention_state", { length: 16 }).default('backlog').notNull(),
	priority: integer().default(0).notNull(),
	primaryParentId: varchar("primary_parent_id", { length: 36 }),
	// Projection of the Thread's current primary in-progress step's kind
	// (`inquiry_thread_steps`). The column stays so the Thread read shape is
	// unchanged and the contradiction CHECK below stays enforceable; the step
	// row is the authority and the service writes both in one transaction.
	nextFocusKind: varchar("next_focus_kind", { length: 32 }),
	nextFocusNote: text("next_focus_note"),
	blockedReason: text("blocked_reason"),
	version: integer().default(1).notNull(),
	createdFrom: varchar("created_from", { length: 32 }).default('user').notNull(),
	producerIdempotencyKey: varchar("producer_idempotency_key", { length: 128 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_threads_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_inquiry_threads_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_inquiry_threads_primary_parent_id").using("btree", table.primaryParentId.asc().nullsLast()),
	index("ix_inquiry_threads_attention_state").using("btree", table.projectId.asc().nullsLast(), table.attentionState.asc().nullsLast()),
	uniqueIndex("uq_inquiry_threads_project_idempotency").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.producerIdempotencyKey.asc().nullsLast()).where(sql`producer_idempotency_key IS NOT NULL`),
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
			foreignColumns: [table.objectId, table.projectId, table.spaceId],
			name: "inquiry_threads_primary_parent_fkey"
		}),
	unique("uq_inquiry_threads_space_id_id").on(table.objectId, table.spaceId),
	unique("uq_inquiry_threads_id_project_space").on(table.objectId, table.projectId, table.spaceId),
	// Root attachment: the FK that makes a Thread an ontology object.
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "inquiry_threads_object_id_fkey"
		}).onDelete("cascade"),
	check("ck_inquiry_threads_kind", sql`(kind)::text = ANY (ARRAY[('question'::character varying)::text, ('hypothesis'::character varying)::text])`),
	check("ck_inquiry_threads_lifecycle_status", sql`(lifecycle_status)::text = ANY (ARRAY[('active'::character varying)::text, ('resolved'::character varying)::text, ('rejected'::character varying)::text, ('superseded'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_inquiry_threads_attention_state", sql`(attention_state)::text = ANY (ARRAY[('focused'::character varying)::text, ('monitoring'::character varying)::text, ('backlog'::character varying)::text, ('blocked'::character varying)::text, ('resolved'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_inquiry_threads_created_from", sql`(created_from)::text = ANY (ARRAY[('user'::character varying)::text, ('ai_candidate'::character varying)::text, ('decomposition'::character varying)::text])`),
	// A step and a blocking reason contradict each other, so a Thread may never
	// hold both. What this no longer requires is that a focused Thread hold one
	// of them: a Thread between rounds, or one whose only running work is a
	// background search, is legitimately doing neither. The former XOR made
	// "focus this Thread" refuse until a next step had been picked from a
	// menu — the invariant was itself a source of the busywork the step model
	// exists to remove.
	check("ck_inquiry_threads_focused_next_focus", sql`next_focus_kind IS NULL OR blocked_reason IS NULL`),
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
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.spaceId],
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
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.spaceId],
			name: "inquiry_hypothesis_states_thread_fkey"
		}).onDelete("cascade"),
	check("ck_inquiry_hypothesis_states_evaluation_state", sql`(evaluation_state)::text = ANY (ARRAY[('untested'::character varying)::text, ('supported'::character varying)::text, ('challenged'::character varying)::text, ('contradicted'::character varying)::text, ('inconclusive'::character varying)::text])`),
	check("ck_inquiry_hypothesis_states_confidence", sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 100)`),
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
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
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
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
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
		foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
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
		foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
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
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
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
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_work_events_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_thread_work_events_space_id_fkey"
		}),
]);

// A step is one attempt at advancing a Thread: what was going to be done, that
// it was started, what it produced, and which round it belonged to. Before
// this table the same information was a single `varchar(32)` on the Thread,
// which could state an intention and nothing else — no start, no outcome, no
// history — so a user who followed the call to action into another Area left
// no trace, and rounds had no factual basis.
//
// `slot` is what keeps human attention singular while long-running system work
// continues: an action with an operation behind it (search, experiment) moves
// to `background` once started and frees the `primary` slot immediately.
export const inquiryThreadSteps = pgTable("inquiry_thread_steps", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	kind: varchar({ length: 32 }).notNull(),
	status: varchar({ length: 16 }).default('in_progress').notNull(),
	slot: varchar({ length: 16 }).default('primary').notNull(),
	// The note belongs to the step it describes rather than to the Thread, so
	// a note written for a background search is not lost just because the
	// Thread column projects the primary slot only.
	note: text(),
	// What this step produced, once it exists. Deliberately a loose reference
	// and not an FK: the targets live in six different Areas, and a step must
	// survive its target being deleted rather than cascade away with it.
	targetRefKind: varchar("target_ref_kind", { length: 32 }),
	targetRefId: varchar("target_ref_id", { length: 36 }),
	// Set when the round closes out, which is what makes Iteration history
	// able to say which steps a round actually went through.
	iterationId: varchar("iteration_id", { length: 36 }),
	origin: varchar({ length: 16 }).default('user').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_thread_steps_thread_id").using("btree", table.threadId.asc().nullsLast(), table.createdAt.desc()),
	index("ix_inquiry_thread_steps_project_id").using("btree", table.projectId.asc().nullsLast()),
	// The single-primary-step rule, enforced by the database rather than by
	// whichever caller remembers it.
	uniqueIndex("uq_inquiry_thread_steps_primary_open").using("btree", table.threadId.asc().nullsLast()).where(sql`slot = 'primary' AND status = 'in_progress'`),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_steps_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_thread_steps_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_thread_steps_space_id_fkey"
		}),
	// An Iteration is deleted only with its Thread, which takes the steps too;
	// this keeps the round pointer honest if one is ever removed on its own.
	// Split in two on purpose: SET NULL clears every column of the key it is
	// declared on, so a composite key carrying space_id would blank the tenant
	// along with the pointer. The single-column reference does the clearing and
	// the composite one enforces tenancy without cascading.
	foreignKey({
			columns: [table.iterationId],
			foreignColumns: [inquiryIterations.id],
			name: "inquiry_thread_steps_iteration_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.iterationId, table.projectId, table.spaceId],
			foreignColumns: [inquiryIterations.id, inquiryIterations.projectId, inquiryIterations.spaceId],
			name: "inquiry_thread_steps_iteration_fkey"
		}),
	check("ck_inquiry_thread_steps_kind", sql`(kind)::text = ANY (ARRAY[('clarify_or_decompose'::character varying)::text, ('search_acquisition'::character varying)::text, ('design_run_experiment'::character varying)::text, ('read_evidence'::character varying)::text, ('synthesize'::character varying)::text, ('promote_knowledge'::character varying)::text, ('create_decision_case'::character varying)::text, ('create_delivery_task'::character varying)::text])`),
	check("ck_inquiry_thread_steps_status", sql`(status)::text = ANY (ARRAY[('in_progress'::character varying)::text, ('done'::character varying)::text, ('abandoned'::character varying)::text])`),
	check("ck_inquiry_thread_steps_slot", sql`(slot)::text = ANY (ARRAY[('primary'::character varying)::text, ('background'::character varying)::text])`),
	check("ck_inquiry_thread_steps_origin", sql`(origin)::text = ANY (ARRAY[('user'::character varying)::text, ('advice'::character varying)::text, ('system'::character varying)::text])`),
	check("ck_inquiry_thread_steps_completed_at", sql`(status = 'in_progress') = (completed_at IS NULL)`),
	check("ck_inquiry_thread_steps_target_ref", sql`(target_ref_kind IS NULL) = (target_ref_id IS NULL)`),
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
			foreignColumns: [inquiryThreads.objectId, inquiryThreads.projectId, inquiryThreads.spaceId],
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
