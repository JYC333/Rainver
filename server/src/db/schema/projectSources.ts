import { pgTable, index, unique, check, foreignKey, varchar, text, integer, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { projects } from "./projects.js";
import { sourceConnections, sourceItems } from "./sources.js";
import { sourceChannels } from "./sourceChannels.js";

export const projectSourceBindings = pgTable("project_source_bindings", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	sourceChannelId: varchar("source_channel_id", { length: 36 }).notNull(),
	bindingKey: varchar("binding_key", { length: 128 }).default('default').notNull(),
	status: varchar({ length: 32 }).notNull(),
	priority: integer().notNull(),
	deliveryScope: varchar("delivery_scope", { length: 32 }).default('project_members').notNull(),
	collectionNotificationsEnabled: boolean("collection_notifications_enabled").default(true).notNull(),
	standingComparisonEnabled: boolean("standing_comparison_enabled").default(false).notNull(),
	filtersJson: jsonb("filters_json").notNull(),
	routingPolicyJson: jsonb("routing_policy_json").notNull(),
	extractionPolicyJson: jsonb("extraction_policy_json").notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_source_bindings_created_by_user_id").using("btree", table.createdByUserId.asc().nullsLast()),
	index("ix_project_source_bindings_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_project_source_bindings_source_channel_id").using("btree", table.sourceChannelId.asc().nullsLast()),
	index("ix_project_source_bindings_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_source_bindings_status").using("btree", table.status.asc().nullsLast()),
	unique("uq_project_source_bindings_id_space_id").on(table.id, table.spaceId),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "project_source_bindings_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_source_bindings_project_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceChannelId, table.spaceId],
			foreignColumns: [sourceChannels.id, sourceChannels.spaceId],
			name: "project_source_bindings_source_channel_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_source_bindings_space_id_fkey"
		}),
	unique("uq_project_source_bindings_project_channel").on(table.bindingKey, table.projectId, table.sourceChannelId, table.spaceId),
	check("ck_project_source_bindings_delivery_scope", sql`(delivery_scope)::text = ANY (ARRAY[('project_members'::character varying)::text, ('source_subscribers'::character varying)::text])`),
	check("ck_project_source_bindings_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_project_source_bindings_extraction_policy_object", sql`jsonb_typeof(extraction_policy_json) = 'object'::text`),
	check("ck_project_source_bindings_profile_key_format", sql`NOT (extraction_policy_json ? 'profile_key') OR (jsonb_typeof(extraction_policy_json->'profile_key') = 'string'::text AND char_length(extraction_policy_json->>'profile_key') BETWEEN 1 AND 128 AND (extraction_policy_json->>'profile_key') ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$')`),
]);

export const projectSourceItemLinks = pgTable("project_source_item_links", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	projectSourceBindingId: varchar("project_source_binding_id", { length: 36 }).notNull(),
	sourceChannelId: varchar("source_channel_id", { length: 36 }),
	sourceConnectionId: varchar("source_connection_id", { length: 36 }),
	sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	matchedAt: timestamp("matched_at", { withTimezone: true, mode: 'string' }).notNull(),
	matchReason: text("match_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_source_item_links_binding_id").using("btree", table.projectSourceBindingId.asc().nullsLast()),
	index("ix_project_source_item_links_matched_at").using("btree", table.matchedAt.asc().nullsLast()),
	index("ix_project_source_item_links_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_project_source_item_links_source_channel_id").using("btree", table.sourceChannelId.asc().nullsLast()),
	index("ix_project_source_item_links_source_connection_id").using("btree", table.sourceConnectionId.asc().nullsLast()),
	index("ix_project_source_item_links_source_item_id").using("btree", table.sourceItemId.asc().nullsLast()),
	index("ix_project_source_item_links_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.projectSourceBindingId],
			foreignColumns: [projectSourceBindings.id],
			name: "project_source_item_links_binding_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_source_item_links_project_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceConnectionId],
			foreignColumns: [sourceConnections.id],
			name: "project_source_item_links_source_connection_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceChannelId, table.spaceId],
			foreignColumns: [sourceChannels.id, sourceChannels.spaceId],
			name: "project_source_item_links_source_channel_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceItemId],
			foreignColumns: [sourceItems.id],
			name: "project_source_item_links_source_item_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_source_item_links_space_id_fkey"
		}),
	unique("uq_project_source_item_links_binding_item").on(table.projectSourceBindingId, table.projectId, table.sourceItemId, table.spaceId),
	check("ck_project_source_item_links_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
]);
