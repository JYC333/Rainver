import { pgTable, index, unique, check, foreignKey, varchar, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaceLocations } from "./workspaceLocations.js";

/**
 * ADR 0016 D14: a task thread pins a run-file-lifecycle conversation to one
 * WorkspaceLocation (execution-topology-and-project-control-plane-plan.md
 * P1 — previously a (host, project_folder) pair) — the vendor CLI's own
 * session store lives on that Location's disk, so continuity cannot cross
 * Locations. The first dispatch in a thread starts a fresh vendor session;
 * a follow-up dispatch passes this thread's id and resumes
 * `vendor_session_id`. `status` flips to `session_reset` (from `active`)
 * when the daemon reports the vendor session is gone and the run had to
 * restart fresh — the UI surfaces this rather than silently resuming into a
 * new, unrelated session.
 */
export const hostTaskThreads = pgTable("host_task_threads", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	workspaceLocationId: varchar("workspace_location_id", { length: 36 }).notNull(),
	adapterType: varchar("adapter_type", { length: 64 }).notNull(),
	// Which copy of the runtime on the host this thread runs on — `own` (the
	// machine's PATH install) or `managed:<version>`. Pinned like
	// `adapter_type`: the vendor session lives inside that installation's
	// login state, so a thread cannot move between copies.
	runtimeInstallation: varchar("runtime_installation", { length: 64 }).default('own').notNull(),
	vendorSessionId: varchar("vendor_session_id", { length: 256 }),
	lastRunId: varchar("last_run_id", { length: 36 }),
	status: varchar({ length: 24 }).notNull().default('active'),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	// control-center-phase2-plan.md P2 (C4): non-null when the thread's
	// message queue is paused — set whenever a dispatched Run's terminal
	// status is anything other than `succeeded` (failed, cancelled, timed
	// out, orphaned...), never auto-cleared. A separate concern from
	// `status`/`session_reset` (vendor session continuity): a thread can be
	// `active` and queue-paused at the same time — the session is fine, the
	// user just needs to look at what went wrong before the next queued
	// message goes out.
	queuePausedAt: timestamp("queue_paused_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_host_task_threads_workspace_location_id").using("btree", table.workspaceLocationId.asc().nullsLast()),
	unique("uq_host_task_threads_id_location").on(table.id, table.workspaceLocationId),
	foreignKey({
			columns: [table.workspaceLocationId],
			foreignColumns: [workspaceLocations.id],
			name: "host_task_threads_workspace_location_id_fkey"
		}).onDelete("cascade"),
	check("ck_host_task_threads_status", sql`status IN ('active', 'session_reset')`),
]);
