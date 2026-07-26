import { pgTable, index, unique, check, foreignKey, varchar, text, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./auth";
import { spaces } from "./spaces";
import { projectFolders } from "./projectFolders";

export const runtimeToolBindings = pgTable("runtime_tool_bindings", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	agentId: varchar("agent_id", { length: 36 }),
	capabilityId: varchar("capability_id", { length: 128 }),
	runtimeAdapterType: varchar("runtime_adapter_type", { length: 64 }).notNull(),
	externalType: varchar("external_type", { length: 64 }).notNull(),
	externalRef: varchar("external_ref", { length: 512 }).notNull(),
	displayName: varchar("display_name", { length: 256 }).notNull(),
	requiredScopesJson: jsonb("required_scopes_json"),
	credentialRef: varchar("credential_ref", { length: 256 }),
	dataExposureLevel: varchar("data_exposure_level", { length: 64 }).default('unknown').notNull(),
	observabilityLevel: varchar("observability_level", { length: 64 }).default('black_box').notNull(),
	sideEffectLevel: varchar("side_effect_level", { length: 32 }).default('none').notNull(),
	approvalRequired: boolean("approval_required").default(true).notNull(),
	enabled: boolean().default(false).notNull(),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_runtime_tool_bindings_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_runtime_tool_bindings_capability_id").using("btree", table.capabilityId.asc().nullsLast()),
	index("ix_runtime_tool_bindings_enabled").using("btree", table.enabled.asc().nullsLast()),
	index("ix_runtime_tool_bindings_runtime_adapter_type").using("btree", table.runtimeAdapterType.asc().nullsLast()),
	index("ix_runtime_tool_bindings_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_runtime_tool_bindings_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "runtime_tool_bindings_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "runtime_tool_bindings_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "runtime_tool_bindings_project_folder_id_fkey"
		}),
	check("ck_runtime_tool_bindings_data_exposure_level", sql`(data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text])`),
	check("ck_runtime_tool_bindings_external_type", sql`(external_type)::text = ANY (ARRAY[('codex_plugin'::character varying)::text, ('claude_skill'::character varying)::text, ('claude_hook'::character varying)::text, ('mcp_server'::character varying)::text, ('app_integration'::character varying)::text, ('cli_tool'::character varying)::text])`),
	check("ck_runtime_tool_bindings_observability_level", sql`(observability_level)::text = ANY (ARRAY[('full_trace'::character varying)::text, ('structured_events'::character varying)::text, ('artifacts_only'::character varying)::text, ('final_output_only'::character varying)::text, ('black_box'::character varying)::text])`),
	check("ck_runtime_tool_bindings_side_effect_level", sql`(side_effect_level)::text = ANY (ARRAY[('none'::character varying)::text, ('local_files'::character varying)::text, ('external_read'::character varying)::text, ('external_write'::character varying)::text, ('sensitive'::character varying)::text])`),
]);

export const spaceRuntimeToolPolicies = pgTable("space_runtime_tool_policies", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runtime: varchar({ length: 64 }).notNull(),
	enabled: boolean().default(false).notNull(),
	defaultVersion: varchar("default_version", { length: 128 }),
	allowedVersionsJson: jsonb("allowed_versions_json").default([]).notNull(),
	updatedByUserId: varchar("updated_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_space_runtime_tool_policies_runtime").using("btree", table.runtime.asc().nullsLast()),
	index("ix_space_runtime_tool_policies_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_space_runtime_tool_policies_updated_by_user_id").using("btree", table.updatedByUserId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "space_runtime_tool_policies_space_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.updatedByUserId],
			foreignColumns: [users.id],
			name: "space_runtime_tool_policies_updated_by_user_id_fkey"
		}).onDelete("set null"),
	unique("uq_space_runtime_tool_policies_space_runtime").on(table.runtime, table.spaceId),
]);
