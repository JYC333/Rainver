import { pgTable, index, uniqueIndex, check, foreignKey, varchar, timestamp, jsonb, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaceLocations } from "./workspaceLocations.js";
import { agents } from "./agents.js";
import { tasks } from "./tasks.js";
import { hosts } from "./hosts.js";
import { sessions } from "./sessions.js";

/**
 * ADR 0016 D14: a host thread pins a run-file-lifecycle conversation to one
 * WorkspaceLocation (execution-topology-and-project-control-plane-plan.md
 * P1 — previously a (host, project_folder) pair) — the vendor CLI's own
 * session store lives on that Location's disk, so continuity cannot cross
 * Locations. The first dispatch in a thread starts a fresh vendor session;
 * a follow-up dispatch passes this thread's id and resumes
 * `vendor_session_id`. `status` flips to `session_reset` (from `active`)
 * when the daemon reports the vendor session is gone and the run had to
 * restart fresh — the UI surfaces this rather than silently resuming into a
 * new, unrelated session.
 *
 * D9 generalises the former task-only table without creating a second session
 * authority. Legacy task rows may have a null task_id because the old thread
 * row did not store its Task owner; their messages remain the authoritative
 * recoverable link. A Task-shaped row may carry task_id, while direct and
 * Conversation-shaped rows carry their own explicit container identity.
 * The existing host_task_thread_id columns on messages, events, and runs are
 * intentionally retained as the run-side thread reference. Conversation
 * rows in this table are keyed by `(session_id, agent_id)` and never by Room.
 * Room membership is derived through `sessions`.
 */
export const hostThreads = pgTable("host_threads", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	executionHostId: varchar("execution_host_id", { length: 36 }),
	workspaceLocationId: varchar("workspace_location_id", { length: 36 }),
	workspaceMode: varchar("workspace_mode", { length: 16 }).notNull().default('location'),
	taskId: varchar("task_id", { length: 36 }),
	sessionId: varchar("session_id", { length: 36 }),
	agentId: varchar("agent_id", { length: 36 }),
	containerKind: varchar("container_kind", { length: 16 }),
	containerUserId: varchar("container_user_id", { length: 36 }),
	adapterType: varchar("adapter_type", { length: 64 }).notNull(),
	// Which copy of the runtime on the host this thread runs on — `own` (the
	// machine's PATH install) or `managed:<version>`. Pinned like
	// `adapter_type`: the vendor session lives inside that installation's
	// login state, so a thread cannot move between copies.
	runtimeInstallation: varchar("runtime_installation", { length: 64 }).default('own').notNull(),
	vendorSessionId: varchar("vendor_session_id", { length: 256 }),
	lastRunId: varchar("last_run_id", { length: 36 }),
	lastSessionId: varchar("last_session_id", { length: 36 }),
	// This token is claimed before a Run exists and replaced with that Run's id
	// before commit, so two dispatches cannot concurrently use one vendor
	// session or overwrite its continuity state.
	dispatchLockId: varchar("dispatch_lock_id", { length: 36 }),
	// Every vendor session this thread has moved on from (reset, close, or a
	// broken resume). Kept so ambient session import can still tell the
	// Agent's old sessions apart from the owner's own history on the same
	// host — `vendor_session_id` alone is cleared at exactly those moments.
	retiredVendorSessionIds: jsonb("retired_vendor_session_ids").default([]).notNull(),
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
	pendingArchiveAt: timestamp("pending_archive_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_host_threads_workspace_location_id").using("btree", table.workspaceLocationId.asc().nullsLast()),
	index("ix_host_threads_workspace_mode").using("btree", table.workspaceMode.asc().nullsLast()),
	index("ix_host_threads_session_id").on(table.spaceId, table.sessionId),
	uniqueIndex("uq_host_threads_conversation_agent_active")
		.on(table.sessionId, table.agentId)
		.where(sql`container_kind = 'conversation' AND status IN ('active', 'session_reset') AND session_id IS NOT NULL`),
	uniqueIndex("uq_host_threads_direct_agent_user_active")
		.on(table.agentId, table.containerUserId)
		.where(sql`status IN ('active', 'session_reset')`),
	foreignKey({
			columns: [table.executionHostId],
			foreignColumns: [hosts.id],
			name: "host_threads_execution_host_id_fkey"
		}),
	foreignKey({
			columns: [table.workspaceLocationId],
			foreignColumns: [workspaceLocations.id],
			name: "host_threads_workspace_location_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspaceLocationId, table.executionHostId],
			foreignColumns: [workspaceLocations.id, workspaceLocations.executionHostId],
			name: "host_threads_workspace_location_host_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.taskId],
			foreignColumns: [tasks.id],
			name: "host_threads_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId, table.spaceId],
			foreignColumns: [sessions.id, sessions.spaceId],
			name: "host_threads_session_space_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.agentId, table.spaceId],
			foreignColumns: [agents.id, agents.spaceId],
			name: "host_threads_agent_space_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "host_threads_agent_id_fkey"
		}),
	check("ck_host_threads_workspace_mode", sql`workspace_mode IN ('location', 'managed') AND (workspace_mode <> 'location' OR workspace_location_id IS NOT NULL) AND (workspace_mode <> 'managed' OR workspace_location_id IS NULL)`),
	check("ck_host_threads_owner", sql`
		(workspace_location_id IS NOT NULL AND session_id IS NULL AND agent_id IS NULL AND container_kind IS NULL AND container_user_id IS NULL)
		OR (task_id IS NULL AND session_id IS NULL AND agent_id IS NOT NULL AND container_kind = 'direct' AND container_user_id IS NOT NULL)
		OR (task_id IS NULL AND session_id IS NOT NULL AND space_id IS NOT NULL AND execution_host_id IS NOT NULL AND agent_id IS NOT NULL AND container_kind = 'conversation' AND container_user_id IS NULL)
	`),
	check("ck_host_threads_container_kind", sql`container_kind IS NULL OR container_kind IN ('direct', 'conversation')`),
	check("ck_host_threads_status", sql`status IN ('active', 'session_reset', 'closed')`),
	check("ck_host_threads_retired_sessions_array", sql`jsonb_typeof(retired_vendor_session_ids) = 'array'`),
]);
