import { pgTable, index, unique, uniqueIndex, check, foreignKey, varchar, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actors } from "./agents.js";
import { spaces } from "./spaces.js";
import { projects } from "./projects.js";
import { tasks } from "./tasks.js";

/**
 * How a Project advanced: one append-only stream, and one fold of it.
 *
 * `run_events` is deliberately not extended for this. It is Run-scoped harness
 * evidence with a Run's lifetime; Project advancement outlives every Run that
 * produced it and has to survive their retention. Two different lifetimes in
 * one table is how a stream becomes unqueryable.
 */
export const projectWorkEvents = pgTable("project_work_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	// Closed-set validation is the registry's job (B12F), so the column carries
	// a format constraint only. `modules/projectWork/eventKinds.ts` is the
	// replacement, and a demoted constraint without one would be strictly worse
	// than the constraint it replaced.
	eventKind: varchar("event_kind", { length: 64 }).notNull(),
	subjectType: varchar("subject_type", { length: 32 }).notNull(),
	subjectId: varchar("subject_id", { length: 36 }).notNull(),
	// Actor-neutral from the start. A responsibility handoff whose recipient can
	// only be an Agent has to be redesigned the first time the answer is "wait
	// for the supplier" or "wait for Tuesday", and `actors` already spans user,
	// agent, system, automation, connector, integration, service and job.
	actorId: varchar("actor_id", { length: 36 }).notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	correlationId: varchar("correlation_id", { length: 64 }),
	causationId: varchar("causation_id", { length: 64 }),
	idempotencyKey: varchar("idempotency_key", { length: 256 }),
	dataJson: jsonb("data_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_work_events_project_occurred").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.occurredAt.desc().nullsLast()),
	index("ix_project_work_events_subject").using("btree", table.spaceId.asc().nullsLast(), table.subjectType.asc().nullsLast(), table.subjectId.asc().nullsLast(), table.occurredAt.desc().nullsLast()),
	index("ix_project_work_events_kind").using("btree", table.spaceId.asc().nullsLast(), table.eventKind.asc().nullsLast(), table.occurredAt.desc().nullsLast()),
	index("ix_project_work_events_correlation").using("btree", table.correlationId.asc().nullsLast()).where(sql`correlation_id IS NOT NULL`),
	// Every Updates page asks, per row, whether something reversed it — a
	// lateral lookup per row of the page. The predicate must be the one the
	// query filters on: with `data_json ? 'undo_of_event_id'` Postgres cannot
	// prove the index applies to a `->>` equality and plans a sequential scan of
	// an append-only table for every row (measured: 1.4s per page at 200k rows,
	// 0.15ms with this predicate).
	index("ix_project_work_events_undo_of")
		.using("btree", table.spaceId.asc().nullsLast(), sql`(data_json->>'undo_of_event_id')`)
		.where(sql`(data_json->>'undo_of_event_id') IS NOT NULL`),
	// At-least-once delivery is the design point: a settlement that runs twice
	// must land once. The partial unique index is the dedupe, so a retry can
	// insert optimistically and treat the conflict as success.
	uniqueIndex("uq_project_work_events_idempotency").using("btree", table.spaceId.asc().nullsLast(), table.idempotencyKey.asc().nullsLast()).where(sql`idempotency_key IS NOT NULL`),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_work_events_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_work_events_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.actorId],
			foreignColumns: [actors.id],
			name: "project_work_events_actor_id_fkey"
		}),
	check("ck_project_work_events_kind_format", sql`event_kind ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`),
	check("ck_project_work_events_data_object", sql`jsonb_typeof(data_json) = 'object'`),
]);

/**
 * The current Loop stage of one Task: a fold of `project_work_events`, never a
 * second authority.
 *
 * Deriving the stage from surrounding facts instead was the first design and it
 * does not survive two requirements. A Task that legitimately skips planning
 * looks identical to one still planning, and a Task sent back to `plan` after a
 * failed check looks identical to one that has already verified — in both cases
 * the facts are the same and only an actor's decision separates them. So the
 * decision is recorded, and this row is the replayable answer to "where is it
 * now" rather than a value anyone edits directly.
 */
export const taskLoopStates = pgTable("task_loop_states", {
	taskId: varchar("task_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	// A Task re-opened by a follow-up starts a new instance rather than
	// rewinding the old one, so a stage history stays readable as a sequence of
	// attempts instead of one oscillating row.
	loopInstanceId: varchar("loop_instance_id", { length: 36 }).notNull(),
	currentStageKey: varchar("current_stage_key", { length: 32 }).notNull(),
	stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastEventId: varchar("last_event_id", { length: 36 }),
	// Optimistic concurrency: a person dragging a card, an agent advancing the
	// stage, and a Run settling can all arrive at once.
	revision: integer().default(1).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_task_loop_states_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	index("ix_task_loop_states_stage").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.currentStageKey.asc().nullsLast()),
	unique("uq_task_loop_states_task_space").on(table.taskId, table.spaceId),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "task_loop_states_space_id_fkey"
		}),
	foreignKey({
			columns: [table.taskId, table.spaceId],
			foreignColumns: [tasks.id, tasks.spaceId],
			name: "task_loop_states_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "task_loop_states_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lastEventId],
			foreignColumns: [projectWorkEvents.id],
			name: "task_loop_states_last_event_id_fkey"
		}),
	check("ck_task_loop_states_stage", sql`current_stage_key IN ('frame', 'plan', 'act', 'verify', 'conclude')`),
	check("ck_task_loop_states_revision", sql`revision >= 1`),
]);
