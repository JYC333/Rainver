import { pgTable, index, uniqueIndex, unique, check, varchar, text, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const codePatchSnapshots = pgTable("code_patch_snapshots", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	proposalId: varchar("proposal_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectFolderId: varchar("project_folder_id", { length: 36 }).notNull(),
	filesJson: jsonb("files_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	status: varchar({ length: 32 }).default('available').notNull(),
	rolledBackByUserId: varchar("rolled_back_by_user_id", { length: 36 }),
	rolledBackAt: timestamp("rolled_back_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_code_patch_snapshots_expires_at").using("btree", table.expiresAt.asc().nullsLast()),
	index("ix_code_patch_snapshots_proposal_id").using("btree", table.proposalId.asc().nullsLast()),
	index("ix_code_patch_snapshots_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	check("ck_code_patch_snapshots_status", sql`(status)::text = ANY (ARRAY[('available'::character varying)::text, ('rolled_back'::character varying)::text, ('pruned'::character varying)::text])`),
]);

export const officialPluginEnablements = pgTable("official_plugin_enablements", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	userId: varchar("user_id", { length: 36 }),
	pluginId: varchar("plugin_id", { length: 128 }).notNull(),
	enabled: boolean().notNull(),
	visible: boolean().default(true).notNull(),
	settingsJson: jsonb("settings_json").default({}).notNull(),
	enabledAt: timestamp("enabled_at", { withTimezone: true, mode: 'string' }),
	enabledByUserId: varchar("enabled_by_user_id", { length: 36 }),
	disabledAt: timestamp("disabled_at", { withTimezone: true, mode: 'string' }),
	disabledByUserId: varchar("disabled_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("official_plugin_enablements_plugin_space_idx").using("btree", table.pluginId.asc().nullsLast(), table.spaceId.asc().nullsLast()).where(sql`(space_id IS NOT NULL)`),
	index("official_plugin_enablements_space_idx").using("btree", table.spaceId.asc().nullsLast()).where(sql`(space_id IS NOT NULL)`),
	uniqueIndex("official_plugin_enablements_space_unique").using("btree", table.pluginId.asc().nullsLast(), table.spaceId.asc().nullsLast()).where(sql`((space_id IS NOT NULL) AND (user_id IS NULL))`),
	uniqueIndex("official_plugin_enablements_user_unique").using("btree", table.pluginId.asc().nullsLast(), table.userId.asc().nullsLast()).where(sql`((space_id IS NULL) AND (user_id IS NOT NULL))`),
	check("official_plugin_enablements_settings_is_object", sql`jsonb_typeof(settings_json) = 'object'::text`),
	check("official_plugin_enablements_plugin_id_non_empty", sql`(plugin_id)::text <> ''::text`),
	check("official_plugin_enablements_scope_check", sql`((space_id IS NOT NULL) AND (user_id IS NULL)) OR ((space_id IS NULL) AND (user_id IS NOT NULL))`),
]);

export const officialPluginEvents = pgTable("official_plugin_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	pluginId: varchar("plugin_id", { length: 128 }).notNull(),
	eventType: varchar("event_type", { length: 64 }).notNull(),
	actorUserId: varchar("actor_user_id", { length: 36 }),
	targetUserId: varchar("target_user_id", { length: 36 }),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("official_plugin_events_plugin_space_idx").using("btree", table.pluginId.asc().nullsLast(), table.spaceId.asc().nullsLast(), table.createdAt.desc().nullsFirst()).where(sql`(space_id IS NOT NULL)`),
	index("official_plugin_events_space_idx").using("btree", table.spaceId.asc().nullsLast(), table.createdAt.desc().nullsFirst()).where(sql`(space_id IS NOT NULL)`),
	check("official_plugin_events_event_type_non_empty", sql`(event_type)::text <> ''::text`),
	check("official_plugin_events_metadata_is_object", sql`jsonb_typeof(metadata_json) = 'object'::text`),
	check("official_plugin_events_plugin_id_non_empty", sql`(plugin_id)::text <> ''::text`),
]);

export const pluginInstalls = pgTable("plugin_installs", {
	id: varchar({ length: 36 }).default(sql`gen_random_uuid()`).primaryKey().notNull(),
	pluginId: varchar("plugin_id", { length: 64 }).notNull(),
	installedVersion: varchar("installed_version", { length: 32 }).notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	source: varchar({ length: 16 }).default('official').notNull(),
	installedAt: timestamp("installed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	installedByUserId: varchar("installed_by_user_id", { length: 36 }),
	packageHash: text("package_hash"),
	manifestJson: jsonb("manifest_json").default({}).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("plugin_installs_status_idx").using("btree", table.status.asc().nullsLast()),
	unique("plugin_installs_plugin_id_unique").on(table.pluginId),
	check("plugin_installs_plugin_id_nonempty", sql`length(TRIM(BOTH FROM (plugin_id)::text)) > 0`),
	check("plugin_installs_source_valid", sql`(source)::text = ANY ((ARRAY['built_in'::character varying, 'official'::character varying, 'local'::character varying])::text[])`),
	check("plugin_installs_status_valid", sql`(status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying, 'removed'::character varying])::text[])`),
]);

export const pluginMigrations = pgTable("plugin_migrations", {
	id: varchar({ length: 36 }).default(sql`gen_random_uuid()`).primaryKey().notNull(),
	pluginId: varchar("plugin_id", { length: 64 }).notNull(),
	pluginVersion: varchar("plugin_version", { length: 32 }).notNull(),
	migrationId: varchar("migration_id", { length: 128 }).notNull(),
	checksum: text(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	status: varchar({ length: 16 }).default('applied').notNull(),
	errorMessage: text("error_message"),
}, (table): PgTableExtraConfigValue[] => [
	index("plugin_migrations_plugin_id_idx").using("btree", table.pluginId.asc().nullsLast()),
	unique("plugin_migrations_unique").on(table.migrationId, table.pluginId),
	check("plugin_migrations_status_valid", sql`(status)::text = ANY ((ARRAY['applied'::character varying, 'failed'::character varying])::text[])`),
]);
