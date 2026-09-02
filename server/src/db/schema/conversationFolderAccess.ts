import {
	check,
	foreignKey,
	index,
	pgTable,
	timestamp,
	uniqueIndex,
	varchar,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projectFolders } from "./projectFolders.js";
import { sessions } from "./sessions.js";
import { spaces } from "./spaces.js";
import { users } from "./auth.js";
import { workspaceLocations } from "./workspaceLocations.js";

/**
 * Explicit filesystem access granted to a Conversation beyond its Primary.
 * The concrete Location is persisted with the grant so an existing
 * Conversation cannot follow a Folder to another checkout implicitly.
 */
export const conversationFolderAccessGrants = pgTable("conversation_folder_access_grants", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	projectFolderId: varchar("project_folder_id", { length: 36 }).notNull(),
	workspaceLocationId: varchar("workspace_location_id", { length: 36 }).notNull(),
	accessMode: varchar("access_mode", { length: 16 }).notNull().default("read"),
	status: varchar({ length: 16 }).notNull().default("active"),
	grantedByUserId: varchar("granted_by_user_id", { length: 36 }).notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
	revokedByUserId: varchar("revoked_by_user_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_conversation_folder_access_grants_session").on(table.spaceId, table.sessionId, table.status),
	index("ix_conversation_folder_access_grants_folder").on(table.spaceId, table.projectFolderId),
	uniqueIndex("uq_conversation_folder_access_grants_active").on(table.sessionId, table.projectFolderId).where(sql`status = 'active'`),
	foreignKey({
		columns: [table.sessionId, table.spaceId],
		foreignColumns: [sessions.id, sessions.spaceId],
		name: "conversation_folder_access_grants_session_scope_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.projectFolderId, table.spaceId],
		foreignColumns: [projectFolders.id, projectFolders.spaceId],
		name: "conversation_folder_access_grants_project_folder_scope_fkey",
	}).onDelete("restrict"),
	foreignKey({
		columns: [table.workspaceLocationId, table.projectFolderId],
		foreignColumns: [workspaceLocations.id, workspaceLocations.projectFolderId],
		name: "conversation_folder_access_grants_location_folder_fkey",
	}).onDelete("restrict"),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "conversation_folder_access_grants_space_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.grantedByUserId],
		foreignColumns: [users.id],
		name: "conversation_folder_access_grants_granted_by_user_id_fkey",
	}).onDelete("restrict"),
	foreignKey({
		columns: [table.revokedByUserId],
		foreignColumns: [users.id],
		name: "conversation_folder_access_grants_revoked_by_user_id_fkey",
	}).onDelete("set null"),
	check("ck_conversation_folder_access_grants_mode", sql`access_mode IN ('read', 'write')`),
	check("ck_conversation_folder_access_grants_status", sql`status IN ('active', 'revoked')`),
	check("ck_conversation_folder_access_grants_revocation", sql`
		(status = 'active' AND revoked_at IS NULL)
		OR (status = 'revoked' AND revoked_at IS NOT NULL)
	`),
]);
