import {
	check,
	foreignKey,
	index,
	pgTable,
	timestamp,
	unique,
	varchar,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { hosts } from "./hosts.js";
import { projectFolders } from "./projectFolders.js";
import { sessions } from "./sessions.js";
import { spaces } from "./spaces.js";
import { workspaceLocations } from "./workspaceLocations.js";

/**
 * The one execution authority for a Project conversation.
 *
 * `sessions` remains the conversation/message identity. This row owns the
 * filesystem selection and the conversation-wide dispatch gate. A draft may
 * contain a visible preflight selection without being initialized; Host,
 * Primary kind, and Primary Location are fixed once `state` becomes
 * `initialized` by the execution-context service.
 */
export const conversationExecutionContexts = pgTable("conversation_execution_contexts", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	executionHostId: varchar("execution_host_id", { length: 36 }),
	primaryWorkspaceMode: varchar("primary_workspace_mode", { length: 16 }),
	primaryProjectFolderId: varchar("primary_project_folder_id", { length: 36 }),
	primaryWorkspaceLocationId: varchar("primary_workspace_location_id", { length: 36 }),
	state: varchar({ length: 16 }).notNull().default("draft"),
	initializedAt: timestamp("initialized_at", { withTimezone: true, mode: "string" }),
	initializedByUserId: varchar("initialized_by_user_id", { length: 36 }),
	dispatchLockId: varchar("dispatch_lock_id", { length: 36 }),
	queuePausedAt: timestamp("queue_paused_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_conversation_execution_contexts_space_id").on(table.spaceId),
	index("ix_conversation_execution_contexts_host_id").on(table.executionHostId),
	unique("uq_conversation_execution_contexts_session_space").on(table.sessionId, table.spaceId),
	foreignKey({
		columns: [table.sessionId, table.spaceId],
		foreignColumns: [sessions.id, sessions.spaceId],
		name: "conversation_execution_contexts_session_scope_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "conversation_execution_contexts_space_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.executionHostId],
		foreignColumns: [hosts.id],
		name: "conversation_execution_contexts_execution_host_id_fkey",
	}).onDelete("restrict"),
	foreignKey({
		columns: [table.primaryProjectFolderId, table.spaceId],
		foreignColumns: [projectFolders.id, projectFolders.spaceId],
		name: "conversation_execution_contexts_primary_folder_scope_fkey",
	}).onDelete("restrict"),
	foreignKey({
		columns: [table.primaryWorkspaceLocationId, table.primaryProjectFolderId],
		foreignColumns: [workspaceLocations.id, workspaceLocations.projectFolderId],
		name: "conversation_execution_contexts_primary_location_folder_fkey",
	}).onDelete("restrict"),
	foreignKey({
		columns: [table.primaryWorkspaceLocationId, table.executionHostId],
		foreignColumns: [workspaceLocations.id, workspaceLocations.executionHostId],
		name: "conversation_execution_contexts_primary_location_host_fkey",
	}).onDelete("restrict"),
	foreignKey({
		columns: [table.initializedByUserId],
		foreignColumns: [users.id],
		name: "conversation_execution_contexts_initialized_by_user_id_fkey",
	}).onDelete("set null"),
	check("ck_conversation_execution_contexts_state", sql`state IN ('draft', 'initialized')`),
	check("ck_conversation_execution_contexts_primary_mode", sql`
		primary_workspace_mode IS NULL
		OR primary_workspace_mode IN ('managed', 'location')
	`),
	check("ck_conversation_execution_contexts_primary_shape", sql`
		(primary_workspace_mode IS NULL AND primary_project_folder_id IS NULL AND primary_workspace_location_id IS NULL)
		OR (primary_workspace_mode = 'managed' AND primary_project_folder_id IS NULL AND primary_workspace_location_id IS NULL)
		OR (primary_workspace_mode = 'location' AND primary_project_folder_id IS NOT NULL AND primary_workspace_location_id IS NOT NULL)
	`),
	check("ck_conversation_execution_contexts_initialization", sql`
		(state = 'draft' AND initialized_at IS NULL)
		OR (
			state = 'initialized'
			AND initialized_at IS NOT NULL
			AND execution_host_id IS NOT NULL
			AND primary_workspace_mode IS NOT NULL
		)
	`),
]);
