import { pgTable, index, unique, check, foreignKey, varchar, text, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hostTaskThreads } from "./hostTaskThreads";
import { runs } from "./runs";
import { projects } from "./projects";

/**
 * control-center-phase2-plan.md P1 (C2): the normalized conversation event
 * log for a remote task thread. Deliberately not a new `run_events.event_type`
 * value — that table's CHECK constraint is a closed vocabulary designed
 * around the server-host semantic-event stream (tool_call_started, etc.),
 * has no `assistant_text`/`diagnostic` concept, and was never wired for
 * incremental per-remote-run writes. This is a sibling table with its own,
 * smaller vocabulary and its own per-thread (not per-run) monotonic cursor,
 * since the read model is "everything said in this conversation", spanning
 * every run/turn dispatched into the thread.
 *
 * `thinking` is dropped at normalization time and never reaches this table
 * (C5) — there is no event_type for it, by design, not by filtering a wider
 * type down.
 */
export const hostThreadEvents = pgTable("host_thread_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	hostTaskThreadId: varchar("host_task_thread_id", { length: 36 }).notNull(),
	// execution-topology-and-project-control-plane-plan.md P1: write-once,
	// denormalized from the thread's Location's Folder's Project at the
	// moment this event is written — a thread's Project never changes, so
	// this cannot drift. Without it, the Project timeline (which scans this
	// table, not `host_task_threads`, since this is the higher-volume one)
	// would need a three-hop join per row.
	projectId: varchar("project_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	eventIndex: integer("event_index").notNull(),
	eventType: varchar("event_type", { length: 32 }).notNull(),
	// assistant_text: the coalesced text segment. diagnostic: one stderr line.
	// plan_updated: a JSON-serialized ACP plan snapshot (appended, never
	// mutated — readers take the thread's latest one).
	text: text(),
	// tool_activity_started/finished: paired by toolCallId.
	toolCallId: varchar("tool_call_id", { length: 128 }),
	toolName: varchar("tool_name", { length: 128 }),
	toolInputSummary: text("tool_input_summary"),
	// ACP runtime replatform P3 (A9): tool_call.kind (execute/edit/read/...),
	// set on tool_activity_started only — paired rows share toolCallId.
	toolKind: varchar("tool_kind", { length: 32 }),
	// ACP runtime replatform P3 (A9): bounded tool-result content, set on
	// tool_activity_finished only. Populated for claude and opencode;
	// codex-acp 1.6.2 reports no result content (a known adapter asymmetry,
	// not a bug — see the ACP runtime replatform plan §4).
	toolResultSummary: text("tool_result_summary"),
	// tool_activity_finished: 'succeeded' | 'failed' | 'in_progress' (ACP's
	// non-terminal status, absorbed as a same-shaped update — not a new
	// event type). status: run lifecycle state ('run_started' |
	// 'run_succeeded' | 'run_failed' | 'run_timeout').
	status: varchar({ length: 32 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_host_thread_events_thread_id").using("btree", table.hostTaskThreadId.asc().nullsLast()),
	index("ix_host_thread_events_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_host_thread_events_project_id").using("btree", table.projectId.asc().nullsLast()),
	unique("uq_host_thread_events_thread_event_index").on(table.hostTaskThreadId, table.eventIndex),
	foreignKey({
			columns: [table.hostTaskThreadId],
			foreignColumns: [hostTaskThreads.id],
			name: "host_thread_events_thread_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "host_thread_events_project_id_fkey"
		}),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "host_thread_events_run_id_fkey"
		}).onDelete("cascade"),
	check("ck_host_thread_events_event_type", sql`(event_type)::text = ANY (ARRAY[('assistant_text'::character varying)::text, ('tool_activity_started'::character varying)::text, ('tool_activity_finished'::character varying)::text, ('status'::character varying)::text, ('diagnostic'::character varying)::text, ('plan_updated'::character varying)::text])`),
]);
