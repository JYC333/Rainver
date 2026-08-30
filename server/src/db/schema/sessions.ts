import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuntimeProfiles, agents, cliCredentialProfiles } from "./agents.js";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { projectFolders } from "./projectFolders.js";
import { projects } from "./projects.js";
import { rooms } from "./rooms.js";

export const sessions = pgTable("sessions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }),
	agentId: varchar("agent_id", { length: 36 }),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	projectId:varchar("project_id",{length:36}),
	roomId: varchar("room_id", { length: 36 }),
	title: varchar({ length: 512 }),
	status: varchar({ length: 32 }).notNull(),
	metadataJson: jsonb("metadata_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_sessions_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_sessions_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_sessions_status").using("btree", table.status.asc().nullsLast()),
	index("ix_sessions_user_id").using("btree", table.userId.asc().nullsLast()),
	index("ix_sessions_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	index("ix_sessions_project_id").on(table.projectId),
	index("ix_sessions_room_id").on(table.roomId),
	unique("uq_sessions_id_space").on(table.id, table.spaceId),
	unique("uq_sessions_id_space_room_project").on(
		table.id,
		table.spaceId,
		table.roomId,
		table.projectId,
	),
	unique("uq_sessions_id_space_user_agent").on(table.id, table.spaceId, table.userId, table.agentId),
	foreignKey({
			columns: [table.agentId, table.spaceId],
			foreignColumns: [agents.id, agents.spaceId],
			name: "sessions_agent_scope_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "sessions_space_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "sessions_user_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
		foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "sessions_project_folder_id_fkey"
	}),
	foreignKey({columns:[table.projectId,table.spaceId],foreignColumns:[projects.id,projects.spaceId],name:"sessions_project_id_fkey"}),
	foreignKey({
		columns: [table.roomId, table.spaceId, table.projectId],
		foreignColumns: [rooms.id, rooms.spaceId, rooms.projectId],
		name: "sessions_room_scope_fkey",
	}).onDelete("cascade"),
	check("ck_sessions_conversation_owner", sql`
		(room_id IS NOT NULL AND project_id IS NOT NULL AND user_id IS NULL AND agent_id IS NULL)
		OR (room_id IS NULL AND user_id IS NOT NULL)
	`),
]);

export const sessionConversationBackends = pgTable("session_conversation_backends", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	runtimeProfileId: varchar("runtime_profile_id", { length: 36 }).notNull(),
	credentialProfileId: varchar("credential_profile_id", { length: 36 }),
	runtimeStateKey: varchar("runtime_state_key", { length: 36 }).notNull(),
	runtimeSessionId: varchar("runtime_session_id", { length: 512 }),
	runtimeContextFingerprint: varchar("runtime_context_fingerprint", { length: 64 }),
	runtimeMessageCursorId: varchar("runtime_message_cursor_id", { length: 36 }),
	runtimeSessionUpdatedAt: timestamp("runtime_session_updated_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_session_conversation_backends_space_id").on(table.spaceId),
	index("ix_session_conversation_backends_runtime_profile_id").on(table.runtimeProfileId),
	index("ix_session_conversation_backends_credential_profile_id").on(table.credentialProfileId),
	unique("uq_session_conversation_backends_session_user_agent").on(table.sessionId, table.userId, table.agentId),
	unique("uq_session_conversation_backends_runtime_state_key").on(table.runtimeStateKey),
	foreignKey({
		columns: [table.sessionId, table.spaceId],
		foreignColumns: [sessions.id, sessions.spaceId],
		name: "session_conversation_backends_session_scope_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "session_conversation_backends_space_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.userId],
		foreignColumns: [users.id],
		name: "session_conversation_backends_user_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.runtimeProfileId, table.spaceId, table.agentId],
		foreignColumns: [agentRuntimeProfiles.id, agentRuntimeProfiles.spaceId, agentRuntimeProfiles.agentId],
		name: "session_conversation_backends_runtime_scope_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.credentialProfileId, table.userId],
		foreignColumns: [cliCredentialProfiles.id, cliCredentialProfiles.ownerUserId],
		name: "session_conversation_backends_credential_owner_fkey",
	}).onDelete("cascade"),
]);

export const messages = pgTable("messages", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }),
	senderAgentId: varchar("sender_agent_id", { length: 36 }),
	role: varchar({ length: 32 }).notNull(),
	content: text().notNull(),
	metadataJson: jsonb("metadata_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_messages_session_id").using("btree", table.sessionId.asc().nullsLast()),
	index("ix_messages_space_session_created").on(table.spaceId, table.sessionId, table.createdAt, table.id),
	index("ix_messages_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_messages_user_id").using("btree", table.userId.asc().nullsLast()),
	index("ix_messages_sender_agent_id").on(table.senderAgentId),
	unique("uq_messages_id_space_session").on(table.id, table.spaceId, table.sessionId),
	// Whether a conversation ever held content from outside Rainver, asked
	// once per reference pick while the Room row lock is held. Partial, so a
	// thread that never held any has no entry at all and the question is
	// answered from the index instead of by visiting every message it has.
	index("ix_messages_external_reference").on(table.spaceId, table.sessionId)
		.where(sql`metadata_json->'reference'->>'trust' = 'external_untrusted'`),
	uniqueIndex("uq_messages_assistant_run").on(
		table.spaceId,
		sql`(metadata_json->>'run_id')`,
	).where(sql`role = 'assistant' AND metadata_json->>'run_id' IS NOT NULL`),
	foreignKey({
			columns: [table.sessionId, table.spaceId],
			foreignColumns: [sessions.id, sessions.spaceId],
			name: "messages_session_scope_fkey",
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "messages_space_id_fkey"
		}),
	foreignKey({
		columns: [table.userId],
			foreignColumns: [users.id],
			name: "messages_user_id_fkey"
	}),
	foreignKey({
		columns: [table.senderAgentId],
		foreignColumns: [agents.id],
		name: "messages_sender_agent_id_fkey",
	}).onDelete("set null"),
	foreignKey({
		columns: [table.senderAgentId, table.spaceId],
		foreignColumns: [agents.id, agents.spaceId],
		name: "messages_sender_agent_scope_fkey",
	}),
	check("ck_messages_role", sql`(role)::text = ANY (ARRAY[('user'::character varying)::text, ('assistant'::character varying)::text, ('system'::character varying)::text, ('tool'::character varying)::text])`),
]);
