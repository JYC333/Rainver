import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { validationRecipes } from "./tasks";

/**
 * execution-topology-and-project-control-plane-plan.md P1 / D2: the logical
 * file/code resource — a repository identity, not a physical checkout.
 * `host_id`/`host_kind`/`root_path`/`display_path` moved to
 * `workspace_locations` (a Folder may now have several physical checkouts,
 * on different ExecutionHosts); this row itself no longer carries any
 * filesystem path.
 */
export const projectFolders = pgTable("project_folders", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	name: varchar({ length: 256 }).notNull(),
	description: text(),
	repoUrl: text("repo_url"),
	status: varchar({ length: 32 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	slug: varchar({ length: 256 }),
	kind: varchar({ length: 16 }).notNull(),
	isPrimary: boolean("is_primary").default(false).notNull(),
	defaultBranch: varchar("default_branch", { length: 256 }),
	protected: boolean().notNull(),
	systemManaged: boolean("system_managed").notNull(),
	registeredFrom: varchar("registered_from", { length: 32 }),
	metadataJson: jsonb("metadata_json"),
	allowExternalRoot: boolean("allow_external_root").default(false).notNull(),
	snapshotRetentionDays: integer("snapshot_retention_days"),
	snapshotMaxCount: integer("snapshot_max_count"),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_folders_slug").using("btree", table.slug.asc().nullsLast()),
	index("ix_project_folders_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_project_folders_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_folders_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "project_folders_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_folders_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_folders_project_id_fkey"
		}),
	unique("uq_project_folders_space_id_id").on(table.id, table.spaceId),
	uniqueIndex("uq_project_folders_one_primary_per_project").using("btree", table.projectId.asc().nullsLast()).where(sql`is_primary`),
	check("ck_project_folders_kind", sql`kind IN ('code', 'data', 'docs')`),
	check("ck_project_folders_status", sql`(status)::text = ANY (ARRAY['active'::text, 'archived'::text, 'stale'::text])`),
]);

export const projectFolderExecutionConfigs = pgTable("project_folder_execution_configs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectFolderId: varchar("project_folder_id", { length: 36 }).notNull(),
	repoType: varchar("repo_type", { length: 64 }),
	techStackJson: jsonb("tech_stack_json"),
	importantPathsJson: jsonb("important_paths_json"),
	forbiddenPathsJson: jsonb("forbidden_paths_json"),
	testCommandsJson: jsonb("test_commands_json"),
	buildCommandsJson: jsonb("build_commands_json"),
	architectureBoundariesJson: jsonb("architecture_boundaries_json"),
	validationRecipeId: varchar("validation_recipe_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_folder_execution_configs_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_folder_execution_configs_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_folder_execution_configs_space_id_fkey"
		}),
	foreignKey({
			columns: [table.validationRecipeId],
			foreignColumns: [validationRecipes.id],
			name: "project_folder_execution_configs_validation_recipe_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "project_folder_execution_configs_project_folder_id_fkey"
		}),
	unique("uq_project_folder_execution_configs_project_folder").on(table.projectFolderId),
]);
