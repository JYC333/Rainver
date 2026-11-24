import { pgTable, index, uniqueIndex, check, foreignKey, varchar, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { runs } from "./runs.js";
import { spaces } from "./spaces.js";
import { projects } from "./projects.js";

/**
 * Data-side consent for an Agent to reach personal or sensitive plugin data
 * (ADR 0030). The toolset is expanded when the grant is written and pinned in
 * `expanded_json`; nothing expands at Run time. Personal consent is the Space
 * owner's, Space-wide; sensitive consent is only the data owner's, bound to one
 * Run (or to the owner's own unattended Runs when explicitly opted in), always
 * expiring and revocable. A revoked or expired row is never reactivated.
 *
 * `project` scope (ADR 0033) is the one consent a core data tool has: the
 * owner's standing, read-only consent bound to one Project, one connection at
 * one generation and one purpose. It has no time limit; it ends when the owner
 * revokes it or turns the tool off, and stops admitting when the connection is
 * disconnected or reconnected (its generation changes). No other consent can
 * be active for a core tool, and no plugin can hold a `project` consent.
 */
export const pluginDataGrants = pgTable("plugin_data_grants", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	pluginId: varchar("plugin_id", { length: 24 }).notNull(),
	toolset: varchar({ length: 8 }).notNull(),
	dataClass: varchar("data_class", { length: 16 }).notNull(),
	scope: varchar({ length: 16 }).notNull(),
	dataOwnerUserId: varchar("data_owner_user_id", { length: 36 }),
	grantedByUserId: varchar("granted_by_user_id", { length: 36 }).notNull(),
	targetRunId: varchar("target_run_id", { length: 36 }),
	pluginVersion: varchar("plugin_version", { length: 32 }).notNull(),
	authorityHash: varchar("authority_hash", { length: 64 }).notNull(),
	expandedJson: jsonb("expanded_json").notNull(),
	status: varchar({ length: 16 }).default("active").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
	/** `project` scope only: the Project whose owner-private conversations may use it. */
	projectId: varchar("project_id", { length: 36 }),
	/**
	 * `project` scope only: the owner's connection (Gmail) and its generation when the owner consented. A
	 * snapshot, not a reference: every live check joins the current connection row at that generation, so a
	 * forgotten (deleted) connection admits nothing, while the ended consent stays as approval evidence.
	 */
	connectionId: varchar("connection_id", { length: 36 }),
	connectionGeneration: integer("connection_generation"),
	/** `project` scope only: what the consent is for (`on_demand_read`). */
	purpose: varchar({ length: 32 }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
	revokedByUserId: varchar("revoked_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_plugin_data_grants_owner").on(table.spaceId, table.dataOwnerUserId, table.status),
	index("ix_plugin_data_grants_run").on(table.spaceId, table.targetRunId),
	uniqueIndex("uq_plugin_data_grants_active").on(
		table.spaceId, table.pluginId, table.toolset, table.dataClass, table.scope,
		sql`COALESCE(${table.targetRunId}, '')`, sql`COALESCE(${table.dataOwnerUserId}, '')`,
		sql`COALESCE(${table.projectId}, '')`, sql`COALESCE(${table.connectionId}, '')`, sql`COALESCE(${table.purpose}, '')`,
	).where(sql`status = 'active'`),
	index("ix_plugin_data_grants_connection").on(table.connectionId),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "plugin_data_grants_space_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.dataOwnerUserId], foreignColumns: [users.id], name: "plugin_data_grants_data_owner_user_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.grantedByUserId], foreignColumns: [users.id], name: "plugin_data_grants_granted_by_user_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.revokedByUserId], foreignColumns: [users.id], name: "plugin_data_grants_revoked_by_user_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.targetRunId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "plugin_data_grants_target_run_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "plugin_data_grants_project_fkey" }).onDelete("cascade"),
	check("ck_plugin_data_grants_toolset", sql`toolset IN ('read', 'write')`),
	check("ck_plugin_data_grants_status", sql`status IN ('active', 'revoked', 'expired')`),
	// Every comparison on a nullable column is preceded by its IS NOT NULL: a NULL comparison would make its
	// branch unknown, and a CHECK that is unknown passes.
	check("ck_plugin_data_grants_shape", sql`(data_class = 'personal' AND scope = 'space' AND data_owner_user_id IS NULL AND target_run_id IS NULL)
		OR (data_class = 'sensitive' AND data_owner_user_id IS NOT NULL AND data_owner_user_id = granted_by_user_id AND expires_at IS NOT NULL
			AND ((scope = 'run' AND target_run_id IS NOT NULL) OR (scope = 'background' AND target_run_id IS NULL AND toolset = 'read')))
		OR (data_class = 'sensitive' AND scope = 'project' AND data_owner_user_id IS NOT NULL AND data_owner_user_id = granted_by_user_id AND toolset = 'read'
			AND target_run_id IS NULL AND expires_at IS NULL AND plugin_id LIKE 'core:%' AND project_id IS NOT NULL AND connection_id IS NOT NULL
			AND connection_generation IS NOT NULL AND connection_generation >= 1 AND purpose IS NOT NULL AND purpose IN ('on_demand_read', 'daily_digest', 'rule_digest', 'application_update'))`),
	check("ck_plugin_data_grants_binding", sql`scope = 'project' OR (project_id IS NULL AND connection_id IS NULL AND connection_generation IS NULL AND purpose IS NULL)`),
	// A core data tool's only active consent is the owner's Project consent (ADR 0033); earlier per-Run rows stay as history.
	check("ck_plugin_data_grants_core_scope", sql`status <> 'active' OR plugin_id NOT LIKE 'core:%' OR scope = 'project'`),
	check("ck_plugin_data_grants_revoked", sql`(status = 'revoked') = (revoked_at IS NOT NULL)`),
]);
