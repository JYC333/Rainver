import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuntimeProfiles, agents, cliCredentialProfiles } from "./agents.js";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { projectFolders } from "./projectFolders.js";
import { projects } from "./projects.js";
import { rooms } from "./rooms.js";
import { runs } from "./runs.js";

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
	// The newest message on the conversation's visible path. Every transcript
	// read is anchored here, so a session that grows a second child under one
	// parent (edit-and-resend, regenerate) shows one branch rather than both
	// interleaved by timestamp.
	//
	// Null only before the first message lands; after that the foreign key
	// below keeps it pointing at a real message of this same session, so a
	// broken pointer fails the write instead of quietly rendering the
	// conversation as empty.
	headMessageId: varchar("head_message_id", { length: 36 }),
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
	index("ix_sessions_head_message_id").on(table.spaceId, table.headMessageId),
	// RESTRICT, not SET NULL: the composite key includes `space_id`, and SET
	// NULL nulls every column of the key — it would detach the session from
	// its tenant to clear a head pointer. Deleting the message a conversation
	// is pointing at is a bug in the caller either way; this makes it fail
	// there rather than silently reduce the transcript to nothing.
	foreignKey({
		columns: [table.headMessageId, table.spaceId, table.id],
		foreignColumns: [messages.id, messages.spaceId, messages.sessionId],
		name: "sessions_head_message_scope_fkey",
	}),
	check("ck_sessions_conversation_owner", sql`
		(room_id IS NOT NULL AND project_id IS NOT NULL AND user_id IS NULL AND agent_id IS NULL)
		OR (room_id IS NULL AND user_id IS NOT NULL)
	`),
]);

export const sessionConversationBackends = pgTable("session_conversation_backends", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	boundByUserId: varchar("bound_by_user_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	runtimeProfileId: varchar("runtime_profile_id", { length: 36 }).notNull(),
	credentialProfileId: varchar("credential_profile_id", { length: 36 }),
	modelNameSnapshot: varchar("model_name_snapshot", { length: 255 }),
	modelProviderIdSnapshot: varchar("model_provider_id_snapshot", { length: 36 }),
	runtimeConfigSnapshotJson: jsonb("runtime_config_snapshot_json").default({}).notNull(),
	runtimePolicySnapshotJson: jsonb("runtime_policy_snapshot_json").default({}).notNull(),
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
	unique("uq_session_conversation_backends_session_agent").on(table.sessionId, table.agentId),
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
		columns: [table.boundByUserId],
		foreignColumns: [users.id],
		name: "session_conversation_backends_bound_by_user_id_fkey",
	}),
	foreignKey({
		columns: [table.runtimeProfileId, table.spaceId, table.agentId],
		foreignColumns: [agentRuntimeProfiles.id, agentRuntimeProfiles.spaceId, agentRuntimeProfiles.agentId],
		name: "session_conversation_backends_runtime_scope_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.credentialProfileId, table.boundByUserId],
		foreignColumns: [cliCredentialProfiles.id, cliCredentialProfiles.ownerUserId],
		name: "session_conversation_backends_credential_owner_fkey",
	}),
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
	// The message this one replies to on the conversation path. Null only for
	// the first message of a session. Two rows sharing a parent are two
	// branches; `sessions.head_message_id` names the visible one.
	parentMessageId: varchar("parent_message_id", { length: 36 }),
	// Where this message sits on its branch, counted from the session's first
	// message. Together with `branch_path` it gives a read the whole visible
	// transcript as one indexed range, instead of walking parent pointers.
	pathDepth: integer("path_depth").notNull(),
	// The lineage of branches this message belongs to, as a materialized
	// prefix: `/` for the original branch, `/<fork message id>/` for a branch
	// started by a fork, and so on.
	//
	// It is a prefix key, which is the whole point. A message is on the
	// visible path exactly when the head's `branch_path` starts with this
	// message's `branch_path` and this message's depth is at most the head's
	// — one indexed range scan over `(space_id, session_id, path_depth)`, no
	// recursion, and `LIMIT` still reaches the index. Walking
	// `parent_message_id` at read time gave the same answer but read the
	// entire conversation to return one page of it.
	branchPath: text("branch_path").notNull(),
	// The Run that produced this assistant message, or that a user message
	// started. A column, not a `metadata_json` key: it is a relationship
	// between two rows and carries a foreign key.
	runId: varchar("run_id", { length: 36 }),
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
	uniqueIndex("uq_messages_assistant_run").on(table.spaceId, table.runId)
		.where(sql`role = 'assistant' AND run_id IS NOT NULL`),
	index("ix_messages_parent_message_id").on(table.spaceId, table.parentMessageId),
	// The transcript read: one session's messages in path order.
	index("ix_messages_session_path").on(
		table.spaceId, table.sessionId, table.pathDepth, table.id,
	),
	// One message per position per branch. This is the write-side guard, not
	// just an integrity nicety: two concurrent appends to one conversation
	// each compute their depth from the head, and under READ COMMITTED the
	// second one's statement snapshot predates the first one's commit, so
	// both would land on the same depth and one would fall off the path. The
	// constraint turns that lost race into a failed insert the caller retries.
	uniqueIndex("uq_messages_branch_position").on(
		table.spaceId, table.sessionId, table.branchPath, table.pathDepth,
	),
	index("ix_messages_run_id").on(table.spaceId, table.runId),
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
	foreignKey({
		columns: [table.parentMessageId, table.spaceId, table.sessionId],
		foreignColumns: [table.id, table.spaceId, table.sessionId],
		name: "messages_parent_message_scope_fkey",
	}),
	foreignKey({
		columns: [table.runId, table.spaceId],
		foreignColumns: [runs.id, runs.spaceId],
		name: "messages_run_scope_fkey",
	}),
	check("ck_messages_role", sql`(role)::text = ANY (ARRAY[('user'::character varying)::text, ('assistant'::character varying)::text, ('system'::character varying)::text, ('tool'::character varying)::text])`),
]);
