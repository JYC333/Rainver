import { pgTable, index, unique, check, foreignKey, varchar, text, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hostThreads } from "./hostThreads.js";
import { runs } from "./runs.js";
import { projects } from "./projects.js";

/**
 * Conversation event log for a host thread, on the built-in host or a paired
 * machine. Do not store these as `run_events.event_type`. That table's CHECK
 * constraint is a closed vocabulary (`tool_call_started` and the rest) and
 * has no `assistant_text` or `diagnostic`. A daemon Run does not write that
 * table incrementally. This sibling has its own
 * smaller vocabulary and its own per-thread (not per-run) monotonic cursor,
 * since the read model is everything said in this conversation, spanning
 * every run dispatched into the thread.
 *
 * Reasoning has its own `assistant_thought` type and follows ACP's explicit
 * agent-thought channel; message text is never reclassified by inspecting it.
 */
export const hostThreadEvents = pgTable("host_thread_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	hostTaskThreadId: varchar("host_task_thread_id", { length: 36 }).notNull(),
	// Write-once, denormalized from the thread's Location's Folder's Project at the
	// moment this event is written — a thread's Project never changes, so
	// this cannot drift. Without it, the Project timeline (which scans this
	// table, not `host_threads`, since this is the higher-volume one)
	// would need a three-hop join per row.
	// Null for a managed-workspace thread: it has no Location, no Folder, and
	// so no Project — its events belong to the Room or direct chat instead.
	projectId: varchar("project_id", { length: 36 }),
	runId: varchar("run_id", { length: 36 }).notNull(),
	eventIndex: integer("event_index").notNull(),
	eventType: varchar("event_type", { length: 32 }).notNull(),
	// assistant_text: the coalesced text segment. assistant_thought: the same,
	// for reasoning. diagnostic: one stderr line.
	// plan_updated: a JSON-serialized ACP plan snapshot (appended, never
	// mutated — readers take the thread's latest one).
	text: text(),
	// tool_activity_started/finished: projected as one entry by toolCallId.
	// Vendor correlation ids are opaque and must remain byte-for-byte intact;
	// truncating them would split one lifecycle into several tool rows.
	toolCallId: text("tool_call_id"),
	// Normalizers redact and bound this display label, while text storage keeps
	// a future provider title from turning event persistence into a Run failure.
	toolName: text("tool_name"),
	toolInputSummary: text("tool_input_summary"),
	// tool_call.kind (execute/edit/read/...),
	// initially set on tool_activity_started and patchable by finished updates.
	toolKind: varchar("tool_kind", { length: 32 }),
	// Bounded tool-result content, set on
	// tool_activity_finished only. Populated for claude and opencode.
	// codex-acp reports no result content. That is an adapter difference.
	toolResultSummary: text("tool_result_summary"),
	// tool activity: 'pending' | 'succeeded' | 'failed' | 'in_progress' (ACP's
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
			foreignColumns: [hostThreads.id],
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
	check("ck_host_thread_events_event_type", sql`(event_type)::text = ANY (ARRAY[('assistant_text'::character varying)::text, ('assistant_thought'::character varying)::text, ('tool_activity_started'::character varying)::text, ('tool_activity_finished'::character varying)::text, ('status'::character varying)::text, ('diagnostic'::character varying)::text, ('plan_updated'::character varying)::text])`),
]);
