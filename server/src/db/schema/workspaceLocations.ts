import { pgTable, index, unique, uniqueIndex, check, foreignKey, varchar, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hosts } from "./hosts.js";
import { projectFolders } from "./projectFolders.js";
import { spaces } from "./spaces.js";

/**
 * execution-topology-and-project-control-plane-plan.md P1 / D2: one
 * physical checkout of a logical `project_folders` row, on one
 * `hosts`/ExecutionHost. A Folder may have several Locations (the same
 * repository checked out on more than one machine or environment); a
 * Location belongs to exactly one Folder and one ExecutionHost.
 *
 * `execution_host_kind` is retained as a denormalized immutable discriminator
 * so the remote-root invariant is enforceable in SQL. A composite foreign key
 * below prevents it from drifting from `hosts.kind`.
 *
 * `execution_ready` is a runtime fact reported by the owning execution host:
 * the server probes its local checkout and a daemon reports whether its local
 * location is reachable. Host liveness and workspace readiness are distinct.
 *
 * `branch`/`git_head`/`dirty` are real, nullable columns. The server-host
 * path uses the existing git helpers; a remote daemon reports the same
 * observations in its hello/heartbeat payload. Workspace content sync and
 * divergence resolution remain out of scope.
 */
export const workspaceLocations = pgTable("workspace_locations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	// Denormalized from `project_folders.space_id` (write-once, a Folder never
	// changes Space) so the per-space `root_path` uniqueness constraint below
	// can be a same-table partial unique index instead of a cross-table trigger
	// — the same reason the old Folder-level host discriminator existed before
	// this table.
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectFolderId: varchar("project_folder_id", { length: 36 }).notNull(),
	executionHostId: varchar("execution_host_id", { length: 36 }).notNull(),
	executionHostKind: varchar("execution_host_kind", { length: 16 }).notNull(),
	displayPath: varchar("display_path", { length: 1024 }),
	rootPath: varchar("root_path", { length: 1024 }),
	branch: varchar({ length: 256 }),
	gitHead: varchar("git_head", { length: 64 }),
	dirty: boolean(),
	executionReady: boolean("execution_ready").default(false).notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	/**
	 * Standing consent to import this folder's ambient CLI history, per
	 * runtime copy, plus whether the offer has been made
	 * (`AmbientImportPolicy`). Absent or empty means never offered and never
	 * synced: continuous sync without an explicit per-Location policy is a
	 * non-goal, because a person typing in their own terminal has not thereby
	 * agreed to publish it to a Project.
	 */
	ambientImportPolicyJson: jsonb("ambient_import_policy_json").default({}).notNull(),
	/**
	 * What the owning daemon last observed about this folder's ambient CLI
	 * history: `AmbientSessionCount[]`, counts and date ranges only, never
	 * content. Persisted rather than held in server memory so the banner can
	 * be rendered on a cold start instead of waiting a heartbeat.
	 */
	ambientSessionCountsJson: jsonb("ambient_session_counts_json").default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_workspace_locations_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	index("ix_workspace_locations_execution_host_id").using("btree", table.executionHostId.asc().nullsLast()),
	index("ix_workspace_locations_status").using("btree", table.status.asc().nullsLast()),
	unique("uq_workspace_locations_id_folder").on(table.id, table.projectFolderId),
	unique("uq_workspace_locations_id_host").on(table.id, table.executionHostId),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "workspace_locations_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "workspace_locations_project_folder_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.executionHostId, table.executionHostKind],
			foreignColumns: [hosts.id, hosts.kind],
			name: "workspace_locations_execution_host_id_fkey"
		}),
	// A Folder has one and only one dispatchable checkout. Historical and newly
	// discovered copies remain archived/stale until an explicit promotion.
	uniqueIndex("uq_workspace_locations_one_active_per_folder").using("btree", table.projectFolderId.asc().nullsLast()).where(sql`status = 'active'`),
	// Carries forward `project_folders`' pre-P1 invariant (`uq_project_folders_space_root_path`):
	// two Locations in the same Space must not claim the same server-host path.
	uniqueIndex("uq_workspace_locations_space_root_path").using(
		"btree",
		table.spaceId.asc().nullsLast(),
		table.rootPath.asc().nullsLast(),
	).where(sql`root_path IS NOT NULL`),
	check("ck_workspace_locations_status", sql`status IN ('active', 'archived', 'stale')`),
	check("ck_workspace_locations_execution_host_kind", sql`execution_host_kind IN ('server', 'remote')`),
	// Root path is authoritative only on the server host (ADR 0016 B64); a
	// remote Location's real path lives on the daemon's machine, never here.
	check("ck_workspace_locations_remote_no_root_path", sql`execution_host_kind <> 'remote' OR root_path IS NULL`),
]);
