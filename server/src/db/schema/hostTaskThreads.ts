import { pgTable, index, unique, check, foreignKey, varchar, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hosts } from "./hosts";
import { projectFolders } from "./projectFolders";

/**
 * ADR 0016 D14: a task thread pins a run-file-lifecycle conversation to one
 * (host, workspace) pair — the vendor CLI's own session store lives on that
 * host's disk, so continuity cannot cross hosts. The first dispatch in a
 * thread starts a fresh vendor session; a follow-up dispatch passes this
 * thread's id and resumes `vendor_session_id`. `status` flips to
 * `session_reset` (from `active`) when the daemon reports the vendor session
 * is gone and the run had to restart fresh — the UI surfaces this rather
 * than silently resuming into a new, unrelated session.
 */
export const hostTaskThreads = pgTable("host_task_threads", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	projectFolderId: varchar("project_folder_id", { length: 36 }).notNull(),
	hostId: varchar("host_id", { length: 36 }).notNull(),
	adapterType: varchar("adapter_type", { length: 64 }).notNull(),
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
	index("ix_host_task_threads_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	index("ix_host_task_threads_host_id").using("btree", table.hostId.asc().nullsLast()),
	unique("uq_host_task_threads_id_folder").on(table.id, table.projectFolderId),
	foreignKey({
			columns: [table.projectFolderId],
			foreignColumns: [projectFolders.id],
			name: "host_task_threads_project_folder_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.hostId],
			foreignColumns: [hosts.id],
			name: "host_task_threads_host_id_fkey"
		}),
	check("ck_host_task_threads_status", sql`status IN ('active', 'session_reset')`),
]);
