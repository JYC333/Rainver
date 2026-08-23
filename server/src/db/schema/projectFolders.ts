import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { validationRecipes } from "./tasks";
import { hosts } from "./hosts";

export const projectFolders = pgTable("project_folders", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	name: varchar({ length: 256 }).notNull(),
	description: text(),
	rootPath: varchar("root_path", { length: 1024 }),
	repoUrl: text("repo_url"),
	status: varchar({ length: 32 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	slug: varchar({ length: 256 }),
	kind: varchar({ length: 16 }).notNull(),
	isPrimary: boolean("is_primary").default(false).notNull(),
	executionEnabled: boolean("execution_enabled").default(true).notNull(),
	defaultBranch: varchar("default_branch", { length: 256 }),
	protected: boolean().notNull(),
	systemManaged: boolean("system_managed").notNull(),
	registeredFrom: varchar("registered_from", { length: 32 }),
	metadataJson: jsonb("metadata_json"),
	allowExternalRoot: boolean("allow_external_root").default(false).notNull(),
	snapshotRetentionDays: integer("snapshot_retention_days"),
	snapshotMaxCount: integer("snapshot_max_count"),
	// ADR 0016: which execution host owns this Folder. `hostKind` is a
	// denormalized, write-once copy of `hosts.kind` at row-creation time —
	// a host's kind never changes after creation, so this cannot drift —
	// kept on the row so filesystem-touching code can guard on it without a
	// join. A `remote` row's `rootPath` stays NULL forever; `displayPath` is
	// the daemon-reported, UI-only label for it (never used for access,
	// mount resolution, or identity — see B64).
	hostId: varchar("host_id", { length: 36 }).notNull(),
	hostKind: varchar("host_kind", { length: 16 }).notNull(),
	displayPath: varchar("display_path", { length: 1024 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_folders_slug").using("btree", table.slug.asc().nullsLast()),
	index("ix_project_folders_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_project_folders_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_folders_status").using("btree", table.status.asc().nullsLast()),
	index("ix_project_folders_host_id").using("btree", table.hostId.asc().nullsLast()),
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
	foreignKey({
			columns: [table.hostId],
			foreignColumns: [hosts.id],
			name: "project_folders_host_id_fkey"
		}),
	unique("uq_project_folders_space_id_id").on(table.id, table.spaceId),
	uniqueIndex("uq_project_folders_space_root_path").using(
		"btree",
		table.spaceId.asc().nullsLast(),
		table.rootPath.asc().nullsLast(),
	).where(sql`root_path IS NOT NULL`),
	uniqueIndex("uq_project_folders_one_primary_per_project").using("btree", table.projectId.asc().nullsLast()).where(sql`is_primary`),
	check("ck_project_folders_kind", sql`kind IN ('code', 'data', 'docs')`),
	check("ck_project_folders_status", sql`(status)::text = ANY (ARRAY['active'::text, 'archived'::text, 'stale'::text])`),
	check("ck_project_folders_host_kind", sql`host_kind IN ('server', 'remote')`),
	// Root path is authoritative only on the server host (ADR 0016 B64); a
	// remote row's real path lives on the daemon's machine, never here.
	check("ck_project_folders_remote_no_root_path", sql`host_kind <> 'remote' OR root_path IS NULL`),
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
	cloudAllowed: boolean("cloud_allowed").default(false).notNull(),
	maxDataExposureLevel: varchar("max_data_exposure_level", { length: 64 }),
	minObservabilityLevel: varchar("min_observability_level", { length: 64 }),
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
	check("ck_project_folder_execution_configs_max_data_exposure_level", sql`(max_data_exposure_level IS NULL) OR ((max_data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text]))`),
	check("ck_project_folder_execution_configs_min_observability_level", sql`(min_observability_level IS NULL) OR ((min_observability_level)::text = ANY (ARRAY[('full_trace'::character varying)::text, ('structured_events'::character varying)::text, ('artifacts_only'::character varying)::text, ('final_output_only'::character varying)::text, ('black_box'::character varying)::text]))`),
]);
