import { pgTable, index, unique, uniqueIndex, check, foreignKey, varchar, text, integer, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaceMemberships, spaces } from "./spaces.js";
import { proposals } from "./proposals.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";

export const skillSources = pgTable("skill_sources", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	sourceType: varchar("source_type", { length: 32 }).notNull(),
	url: text(),
	repo: varchar({ length: 512 }),
	path: text(),
	ref: varchar({ length: 256 }),
	commitSha: varchar("commit_sha", { length: 128 }),
	contentHash: varchar("content_hash", { length: 128 }).notNull(),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_skill_sources_content_hash").using("btree", table.contentHash.asc().nullsLast()),
	index("ix_skill_sources_source_type").using("btree", table.sourceType.asc().nullsLast()),
	index("ix_skill_sources_space_id").using("btree", table.spaceId.asc().nullsLast()),
	check("ck_skill_sources_content_hash_nonempty", sql`length((content_hash)::text) > 0`),
	check("ck_skill_sources_metadata_object", sql`jsonb_typeof(metadata_json) = 'object'::text`),
	check("ck_skill_sources_source_type", sql`(source_type)::text = ANY (ARRAY[('github'::character varying)::text, ('registry'::character varying)::text, ('local_workspace'::character varying)::text, ('upload'::character varying)::text, ('builtin'::character varying)::text])`),
]);

export const skillPackages = pgTable("skill_packages", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	sourceId: varchar("source_id", { length: 36 }).notNull(),
	packageName: varchar("package_name", { length: 256 }).notNull(),
	version: varchar({ length: 64 }),
	license: varchar({ length: 128 }),
	rawStorageRef: text("raw_storage_ref"),
	manifestJson: jsonb("manifest_json").default({}).notNull(),
	normalizedJson: jsonb("normalized_json").default({}).notNull(),
	riskLevel: varchar("risk_level", { length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("uq_skill_packages_id_space").on(table.id, table.spaceId),
	index("ix_skill_packages_risk_level").using("btree", table.riskLevel.asc().nullsLast()),
	index("ix_skill_packages_source_id").using("btree", table.sourceId.asc().nullsLast()),
	index("ix_skill_packages_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_skill_packages_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.sourceId],
			foreignColumns: [skillSources.id],
			name: "skill_packages_source_id_fkey"
		}),
	check("ck_skill_packages_manifest_object", sql`jsonb_typeof(manifest_json) = 'object'::text`),
	check("ck_skill_packages_normalized_object", sql`jsonb_typeof(normalized_json) = 'object'::text`),
	check("ck_skill_packages_risk_level", sql`(risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])`),
	check("ck_skill_packages_status", sql`(status)::text = ANY (ARRAY[('imported'::character varying)::text, ('reviewed'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text, ('superseded'::character varying)::text])`),
]);

export const skillLocalOverlays = pgTable("skill_local_overlays", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	skillPackageId: varchar("skill_package_id", { length: 36 }).notNull(),
	scopeType: varchar("scope_type", { length: 32 }).notNull(),
	scopeId: varchar("scope_id", { length: 128 }),
	overlayJson: jsonb("overlay_json").default({}).notNull(),
	status: varchar({ length: 32 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_skill_local_overlays_package_scope").using("btree", table.spaceId.asc().nullsLast(), table.skillPackageId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.scopeId.asc().nullsLast()),
	index("ix_skill_local_overlays_scope").using("btree", table.spaceId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.scopeId.asc().nullsLast()),
	index("ix_skill_local_overlays_status").using("btree", table.status.asc().nullsLast()),
	uniqueIndex("uq_skill_local_overlays_active_scope").using("btree", sql`space_id`, sql`skill_package_id`, sql`scope_type`, sql`COALESCE(scope_id, ''::character varying)`).where(sql`((status)::text = 'active'::text)`),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "skill_local_overlays_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.skillPackageId],
			foreignColumns: [skillPackages.id],
			name: "skill_local_overlays_skill_package_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "skill_local_overlays_space_id_fkey"
		}),
	check("ck_skill_local_overlays_overlay_object", sql`jsonb_typeof(overlay_json) = 'object'::text`),
	check("ck_skill_local_overlays_scope_id", sql`(((scope_type)::text = 'space'::text) AND (scope_id IS NULL)) OR (((scope_type)::text <> 'space'::text) AND (scope_id IS NOT NULL))`),
	check("ck_skill_local_overlays_scope_type", sql`(scope_type)::text = ANY (ARRAY[('space'::character varying)::text, ('project'::character varying)::text, ('project_folder'::character varying)::text, ('agent'::character varying)::text, ('user'::character varying)::text])`),
	check("ck_skill_local_overlays_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
]);

export const skillPackageFiles = pgTable("skill_package_files", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	skillPackageId: varchar("skill_package_id", { length: 36 }).notNull(),
	path: text().notNull(),
	kind: varchar({ length: 64 }).notNull(),
	contentHash: varchar("content_hash", { length: 128 }),
	contentType: varchar("content_type", { length: 256 }),
	byteLength: integer("byte_length"),
	storageRef: text("storage_ref"),
	/** Exact imported bytes; null for historical inventory-only imports. */
	contentBase64: text("content_base64"),
	included: boolean().default(true).notNull(),
	executable: boolean().default(false).notNull(),
	riskFlagsJson: jsonb("risk_flags_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_skill_package_files_kind").using("btree", table.kind.asc().nullsLast()),
	index("ix_skill_package_files_package_id").using("btree", table.skillPackageId.asc().nullsLast()),
	uniqueIndex("ux_skill_package_files_package_path").using("btree", table.skillPackageId.asc().nullsLast(), table.path.asc().nullsLast()),
	foreignKey({
			columns: [table.skillPackageId],
			foreignColumns: [skillPackages.id],
			name: "skill_package_files_skill_package_id_fkey"
		}).onDelete("cascade"),
	check("ck_skill_package_files_byte_length", sql`(byte_length IS NULL) OR (byte_length >= 0)`),
	check("ck_skill_package_files_path_nonempty", sql`length(path) > 0`),
	check("ck_skill_package_files_risk_flags_object", sql`jsonb_typeof(risk_flags_json) = 'object'::text`),
]);

/** A binding always pins one immutable, reviewed package in one Space. */
export const skillBindings = pgTable("skill_bindings", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	skillPackageId: varchar("skill_package_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	agentId: varchar("agent_id", { length: 36 }),
	userId: varchar("user_id", { length: 36 }),
	enabled: boolean().notNull(),
	proposalId: varchar("proposal_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, table => [
	uniqueIndex("uq_skill_bindings_scope").on(table.spaceId, table.skillPackageId,
		sql`COALESCE(project_id, '')`, sql`COALESCE(agent_id, '')`, sql`COALESCE(user_id, '')`),
	foreignKey({ columns: [table.skillPackageId, table.spaceId], foreignColumns: [skillPackages.id, skillPackages.spaceId] }),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id] }).onDelete("cascade"),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId] }).onDelete("cascade"),
	foreignKey({ columns: [table.agentId, table.spaceId], foreignColumns: [agents.id, agents.spaceId] }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId, table.userId], foreignColumns: [spaceMemberships.spaceId, spaceMemberships.userId] }).onDelete("cascade"),
	foreignKey({ columns: [table.proposalId, table.spaceId], foreignColumns: [proposals.id, proposals.spaceId] }),
	check("ck_skill_bindings_single_scope", sql`num_nonnulls(project_id, agent_id, user_id) <= 1`),
]);
