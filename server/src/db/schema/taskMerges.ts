import { pgTable, index, unique, check, foreignKey, varchar, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces.js";
import { tasks } from "./tasks.js";
import { workspaceLocations } from "./workspaceLocations.js";

/**
 * One merge of a done Task's branch into a Location's main branch (ADR 0016
 * §11): squash, merge onto the main branch in the Task worktree, a conflict
 * to the Task's Agent and then the person, the Task's verification again, and
 * a fast-forward. One row per Task × Location × basis — the `done` write that
 * asked for it — so a Task accepted twice merges twice, and one accepted once
 * never merges twice.
 *
 * The row is the merge's state machine and its record; `task_merge` jobs drive
 * it and the host answers each step. `requested_by_user_id` is whom the merge
 * acts for — a paired host's owner, else the person whose `done` write asked,
 * else the Task's creator — as which the job runs and for whom a resolution
 * Run is admitted. `detail_json` carries what a person is shown for a blocked
 * merge: the conflicted or overlapping files, the failed checks, the error;
 * while the merge is under way it counts how many times in a row the main
 * branch moved under it (`main_moved`).
 */
export const taskMerges = pgTable("task_merges", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	taskId: varchar("task_id", { length: 36 }).notNull(),
	workspaceLocationId: varchar("workspace_location_id", { length: 36 }).notNull(),
	basis: varchar({ length: 256 }).notNull(),
	status: varchar({ length: 32 }).default('queued').notNull(),
	requestedByUserId: varchar("requested_by_user_id", { length: 36 }).notNull(),
	mainBranch: varchar("main_branch", { length: 256 }),
	ontoCommit: varchar("onto_commit", { length: 64 }),
	taskCommit: varchar("task_commit", { length: 64 }),
	mergedCommit: varchar("merged_commit", { length: 64 }),
	detailJson: jsonb("detail_json").default({}).notNull(),
	// The conflict-resolution Run the Task's Agent was given, if any.
	resolutionRunId: varchar("resolution_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	unique("uq_task_merges_task_location_basis").on(table.taskId, table.workspaceLocationId, table.basis),
	index("ix_task_merges_task").using("btree", table.spaceId.asc().nullsLast(), table.taskId.asc().nullsLast()),
	index("ix_task_merges_location_status").using("btree", table.workspaceLocationId.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "task_merges_space_id_fkey"
		}),
	foreignKey({
			columns: [table.taskId, table.spaceId],
			foreignColumns: [tasks.id, tasks.spaceId],
			name: "task_merges_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspaceLocationId],
			foreignColumns: [workspaceLocations.id],
			name: "task_merges_workspace_location_id_fkey"
		}).onDelete("cascade"),
	check("ck_task_merges_status", sql`status IN ('queued', 'rebasing', 'verifying', 'resolving', 'waiting_local_changes', 'conflict', 'verification_failed', 'merged', 'no_changes', 'failed', 'superseded')`),
]);
