import { pgTable, index, uniqueIndex, check, foreignKey, varchar, bigint, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actors } from "./agents.js";
import { spaces } from "./spaces.js";
import { projects } from "./projects.js";

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
	// a format constraint only. `modules/projectWork/eventKinds.ts` asks the
	// registry on the one writer. Do not add a closed-set CHECK here.
	eventKind: varchar("event_kind", { length: 64 }).notNull(),
	subjectType: varchar("subject_type", { length: 32 }).notNull(),
	subjectId: varchar("subject_id", { length: 36 }).notNull(),
	// Actor-neutral. Do not restrict a handoff recipient to an Agent. The answer
	// can be "wait for the supplier" or "wait for Tuesday". `actors` already
	// spans user, agent, system, automation, connector, integration, service
	// and job.
	actorId: varchar("actor_id", { length: 36 }).notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	correlationId: varchar("correlation_id", { length: 64 }),
	causationId: varchar("causation_id", { length: 64 }),
	idempotencyKey: varchar("idempotency_key", { length: 256 }),
	dataJson: jsonb("data_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	// The tiebreak. `occurred_at` is a millisecond timestamp and two events of
	// one advancement chain are written in the same transaction, so ordering
	// `(occurred_at, id)` breaks ties on a random v4 UUID: the board could show
	// the earlier of two same-millisecond events as the latest one. A sequence
	// is monotonic in insert order within the stream, so `(occurred_at, seq)`
	// is total. `byDefault` rather than `always` so a fixture that restores a
	// stream can write its own values.
	// `bigint`, not `number`: the column is 64-bit and a JS number loses
	// precision past 2^53. The Updates cursor keeps `seq` as a
	// decimal string end to end.
	seq: bigint("seq", { mode: "bigint" }).generatedByDefaultAsIdentity().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	// Both readers page the stream by `ORDER BY occurred_at DESC, seq DESC`, so
	// each index carries the whole ordering key, and `nullsFirst()` on the two
	// descending columns is load-bearing: `ORDER BY ... DESC` is NULLS FIRST in
	// Postgres, `DESC NULLS LAST` is a different ordering the planner cannot
	// match to it, and Drizzle writes NULLS LAST unless told otherwise. With
	// the mismatch the planner sorts the whole filtered set on every page
	// instead of an Index Scan under the LIMIT. Do not add a separate
	// `(space_id, subject_type, subject_id, seq)` index. No reader orders by
	// `seq` alone.
	index("ix_project_work_events_project_occurred").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.occurredAt.desc().nullsFirst(), table.seq.desc().nullsFirst()),
	index("ix_project_work_events_subject").using("btree", table.spaceId.asc().nullsLast(), table.subjectType.asc().nullsLast(), table.subjectId.asc().nullsLast(), table.occurredAt.desc().nullsFirst(), table.seq.desc().nullsFirst()),
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
