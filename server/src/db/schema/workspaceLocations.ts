import { pgTable, index, unique, uniqueIndex, check, foreignKey, varchar, boolean, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hosts } from "./hosts";
import { projectFolders } from "./projectFolders";
import { spaces } from "./spaces";

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
	preferred: boolean().default(false).notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_workspace_locations_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	index("ix_workspace_locations_execution_host_id").using("btree", table.executionHostId.asc().nullsLast()),
	index("ix_workspace_locations_status").using("btree", table.status.asc().nullsLast()),
	unique("uq_workspace_locations_id_folder").on(table.id, table.projectFolderId),
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
	// At most one preferred Location per Folder — the default dispatch target
	// when a caller doesn't name one explicitly (D2/D5).
	uniqueIndex("uq_workspace_locations_one_preferred_per_folder").using("btree", table.projectFolderId.asc().nullsLast()).where(sql`preferred`),
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
