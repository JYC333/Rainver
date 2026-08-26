import {
	pgTable,
	index,
	unique,
	check,
	foreignKey,
	jsonb,
	varchar,
	timestamp,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { agents } from "./agents.js";
import { runs } from "./runs.js";
import { spaceMemberships, spaces } from "./spaces.js";

/**
 * Explicit per-resource grants for content whose visibility is
 * `selected_users`. Resource existence is validated by the content-access
 * registry because PostgreSQL cannot express a foreign key to multiple tables.
 */
export const contentAccessGrants = pgTable("content_access_grants", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	resourceType: varchar("resource_type", { length: 64 }).notNull(),
	resourceId: varchar("resource_id", { length: 36 }).notNull(),
	granteeUserId: varchar("grantee_user_id", { length: 36 }).notNull(),
	grantedByUserId: varchar("granted_by_user_id", { length: 36 }).notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default("full").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
	revokedByUserId: varchar("revoked_by_user_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_content_access_grants_grantee").using(
		"btree",
		table.spaceId.asc().nullsLast(),
		table.granteeUserId.asc().nullsLast(),
		table.revokedAt.asc().nullsLast(),
	),
	index("ix_content_access_grants_resource").using(
		"btree",
		table.spaceId.asc().nullsLast(),
		table.resourceType.asc().nullsLast(),
		table.resourceId.asc().nullsLast(),
	),
	unique("uq_content_access_grants_resource_grantee").on(
		table.spaceId,
		table.resourceType,
		table.resourceId,
		table.granteeUserId,
	),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "content_access_grants_space_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.spaceId, table.granteeUserId],
		foreignColumns: [spaceMemberships.spaceId, spaceMemberships.userId],
		name: "content_access_grants_grantee_membership_fkey",
	}),
	foreignKey({
		columns: [table.spaceId, table.grantedByUserId],
		foreignColumns: [spaceMemberships.spaceId, spaceMemberships.userId],
		name: "content_access_grants_grantor_membership_fkey",
	}),
	foreignKey({
		columns: [table.revokedByUserId],
		foreignColumns: [users.id],
		name: "content_access_grants_revoked_by_user_id_fkey",
	}),
	check("ck_content_access_grants_access_level", sql`access_level IN ('full', 'summary')`),
]);

/**
 * Privacy audit for successful reads across human ownership boundaries.
 * Resource identity is polymorphic and is resolved through the content-access
 * registry; the database enforces that owner reads can never enter this table.
 */
export const contentAccessLogs = pgTable("content_access_logs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	resourceType: varchar("resource_type", { length: 64 }).notNull(),
	resourceId: varchar("resource_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	viewerUserId: varchar("viewer_user_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }),
	runId: varchar("run_id", { length: 36 }),
	accessType: varchar("access_type", { length: 64 }).notNull(),
	reason: varchar({ length: 512 }),
	accessedAt: timestamp("accessed_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_content_access_logs_accessed_at").on(table.accessedAt),
	index("ix_content_access_logs_owner").on(table.ownerUserId, table.accessedAt),
	index("ix_content_access_logs_viewer").on(table.viewerUserId, table.accessedAt),
	index("ix_content_access_logs_resource").on(table.spaceId, table.resourceType, table.resourceId, table.accessedAt),
	index("ix_content_access_logs_run_id").on(table.runId),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "content_access_logs_space_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.ownerUserId], foreignColumns: [users.id], name: "content_access_logs_owner_user_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.viewerUserId], foreignColumns: [users.id], name: "content_access_logs_viewer_user_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.agentId], foreignColumns: [agents.id], name: "content_access_logs_agent_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.runId], foreignColumns: [runs.id], name: "content_access_logs_run_id_fkey" }).onDelete("set null"),
	check("ck_content_access_logs_cross_person", sql`viewer_user_id <> owner_user_id`),
	check("ck_content_access_logs_resource_type", sql`resource_type ~ '^[a-z][a-z0-9_]{0,63}$'`),
]);

export const contentDemotionDisclosures = pgTable("content_demotion_disclosures", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	resourceType: varchar("resource_type", { length: 64 }).notNull(),
	resourceId: varchar("resource_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	targetVisibility: varchar("target_visibility", { length: 32 }).notNull(),
	exposureSnapshotJson: jsonb("exposure_snapshot_json").notNull(),
	disclosedAt: timestamp("disclosed_at", { withTimezone: true, mode: "string" }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_content_demotion_disclosures_owner").on(table.ownerUserId, table.expiresAt),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "content_demotion_disclosures_space_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.ownerUserId], foreignColumns: [users.id], name: "content_demotion_disclosures_owner_user_id_fkey" }).onDelete("cascade"),
	check("ck_content_demotion_disclosures_target_visibility", sql`target_visibility IN ('private', 'selected_users')`),
	check("ck_content_demotion_disclosures_resource_type", sql`resource_type ~ '^[a-z][a-z0-9_]{0,63}$'`),
]);
