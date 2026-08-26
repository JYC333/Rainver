import { pgTable, index, unique, uniqueIndex, check, foreignKey, varchar, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { users } from "./auth.js";
import { projects } from "./projects.js";
import { spaces } from "./spaces.js";
import { runs } from "./runs.js";

export const actionApprovalGrants = pgTable("action_approval_grants", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	actionId: varchar("action_id", { length: 128 }).notNull(),
	targetRunId: varchar("target_run_id", { length: 36 }),
	projectId: varchar("project_id", { length: 36 }),
	resourceKind: varchar("resource_kind", { length: 64 }),
	resourceId: varchar("resource_id", { length: 256 }),
	grantedByUserId: varchar("granted_by_user_id", { length: 36 }).notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	maxUses: integer("max_uses"),
	useCount: integer("use_count").default(0).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_action_approval_grants_space_agent_action").using("btree", table.spaceId, table.agentId, table.actionId),
	unique("uq_action_approval_grants_request_binding").on(
		table.id,
		table.spaceId,
		table.agentId,
		table.actionId,
		table.targetRunId,
	),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "action_approval_grants_space_id_fkey" }),
	foreignKey({ columns: [table.agentId, table.spaceId], foreignColumns: [agents.id, agents.spaceId], name: "action_approval_grants_agent_id_fkey" }),
	foreignKey({ columns: [table.grantedByUserId], foreignColumns: [users.id], name: "action_approval_grants_granted_by_user_id_fkey" }),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "action_approval_grants_project_id_fkey" }),
	foreignKey({ columns: [table.targetRunId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "action_approval_grants_target_run_id_fkey" }),
	uniqueIndex("uq_action_approval_grants_active_scope").on(
		table.spaceId,
		table.agentId,
		table.actionId,
		sql`coalesce(${table.targetRunId}, '')`,
		sql`coalesce(${table.projectId}, '')`,
		sql`coalesce(${table.resourceKind}, '')`,
		sql`coalesce(${table.resourceId}, '')`,
	).where(sql`status = 'active'`),
	check("ck_action_approval_grants_status", sql`status IN ('active', 'revoked', 'expired')`),
	check("ck_action_approval_grants_use_count", sql`use_count >= 0 AND (max_uses IS NULL OR (max_uses > 0 AND use_count <= max_uses))`),
]);
