import { pgTable, index, unique, uniqueIndex, check, foreignKey, varchar, text, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./auth";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { policyDecisionRecords } from "./policy";
import { rooms } from "./rooms";
import { projectFolders } from "./projectFolders";
import { messages, sessions } from "./sessions";

export const agentRunGroups = pgTable("agent_run_groups", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	rootRunId: varchar("root_run_id", { length: 36 }),
	managerUserId: varchar("manager_user_id", { length: 36 }).notNull(),
	managerAgentId: varchar("manager_agent_id", { length: 36 }),
	roomId: varchar("room_id", { length: 36 }),
	sessionId: varchar("session_id", { length: 36 }),
	triggerMessageId: varchar("trigger_message_id", { length: 36 }),
	projectId: varchar("project_id", { length: 36 }),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	title: text().notNull(),
	goal: text().notNull(),
	status: varchar({ length: 32 }).notNull(),
	budgetJson: jsonb("budget_json"),
	policySnapshotJson: jsonb("policy_snapshot_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_agent_run_groups_manager_user_updated").using("btree", table.spaceId.asc().nullsLast(), table.managerUserId.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	index("ix_agent_run_groups_root_run").using("btree", table.spaceId.asc().nullsLast(), table.rootRunId.asc().nullsLast()),
	index("ix_agent_run_groups_room_session").on(table.spaceId, table.roomId, table.sessionId, table.createdAt),
	index("ix_agent_run_groups_status_updated").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	foreignKey({
			columns: [table.managerAgentId],
			foreignColumns: [agents.id],
			name: "agent_run_groups_manager_agent_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.managerUserId],
			foreignColumns: [users.id],
			name: "agent_run_groups_manager_user_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.rootRunId],
			foreignColumns: [runs.id],
			name: "agent_run_groups_root_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "agent_run_groups_space_id_fkey"
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.projectFolderId, table.spaceId],
		foreignColumns: [projectFolders.id, projectFolders.spaceId],
		name: "agent_run_groups_project_folder_scope_fkey",
	}).onDelete("restrict"),
	foreignKey({
			columns: [table.managerAgentId, table.spaceId],
			foreignColumns: [agents.id, agents.spaceId],
			name: "fk_agent_run_groups_manager_agent_same_space"
	}),
	foreignKey({
			columns: [table.roomId, table.spaceId, table.projectId],
			foreignColumns: [rooms.id, rooms.spaceId, rooms.projectId],
			name: "agent_run_groups_room_scope_fkey",
		}).onDelete("cascade"),
	foreignKey({
			columns: [
				table.sessionId,
				table.spaceId,
				table.roomId,
				table.projectId,
			],
			foreignColumns: [
				sessions.id,
				sessions.spaceId,
				sessions.roomId,
				sessions.projectId,
			],
			name: "agent_run_groups_room_session_scope_fkey",
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.triggerMessageId, table.spaceId, table.sessionId],
			foreignColumns: [messages.id, messages.spaceId, messages.sessionId],
			name: "agent_run_groups_trigger_message_scope_fkey",
		}),
	foreignKey({
			columns: [table.rootRunId, table.spaceId],
			foreignColumns: [runs.id, runs.spaceId],
			name: "fk_agent_run_groups_root_run_same_space"
		}),
	unique("uq_agent_run_groups_space_id_id").on(table.id, table.spaceId),
	unique("uq_agent_run_groups_run_scope").on(
		table.id,
		table.spaceId,
		table.sessionId,
		table.projectId,
	),
	check("ck_agent_run_groups_room_links", sql`
		(
			room_id IS NULL
			AND session_id IS NULL
			AND trigger_message_id IS NULL
			AND project_id IS NULL
			AND project_folder_id IS NULL
		)
		OR (
			room_id IS NOT NULL
			AND session_id IS NOT NULL
			AND trigger_message_id IS NOT NULL
			AND project_id IS NOT NULL
		)
	`),
	check("ck_agent_run_groups_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('archived'::character varying)::text])`),
]);

export const agentRunGroupMembers = pgTable("agent_run_group_members", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	groupId: varchar("group_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	role: varchar({ length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	capabilitiesJson: jsonb("capabilities_json"),
	contextPolicyJson: jsonb("context_policy_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_agent_run_group_members_agent").using("btree", table.spaceId.asc().nullsLast(), table.agentId.asc().nullsLast()),
	index("ix_agent_run_group_members_group").using("btree", table.spaceId.asc().nullsLast(), table.groupId.asc().nullsLast()),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "agent_run_group_members_agent_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.groupId],
			foreignColumns: [agentRunGroups.id],
			name: "agent_run_group_members_group_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "agent_run_group_members_space_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.agentId, table.spaceId],
			foreignColumns: [agents.id, agents.spaceId],
			name: "fk_agent_run_group_members_agent_same_space"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.groupId, table.spaceId],
			foreignColumns: [agentRunGroups.id, agentRunGroups.spaceId],
			name: "fk_agent_run_group_members_group_same_space"
		}).onDelete("cascade"),
	unique("uq_agent_run_group_members_group_agent").on(table.agentId, table.groupId),
	check("ck_agent_run_group_members_role", sql`(role)::text = ANY (ARRAY[('manager'::character varying)::text, ('planner'::character varying)::text, ('worker'::character varying)::text, ('reviewer'::character varying)::text, ('curator'::character varying)::text, ('observer'::character varying)::text])`),
	check("ck_agent_run_group_members_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('disabled'::character varying)::text])`),
]);

export const agentRunMessages = pgTable("agent_run_messages", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	groupId: varchar("group_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }),
	parentMessageId: varchar("parent_message_id", { length: 36 }),
	senderActorRefJson: jsonb("sender_actor_ref_json").notNull(),
	senderUserId: varchar("sender_user_id", { length: 36 }),
	senderAgentId: varchar("sender_agent_id", { length: 36 }),
	messageType: varchar("message_type", { length: 32 }).notNull(),
	content: text().notNull(),
	mentionsJson: jsonb("mentions_json"),
	metadataJson: jsonb("metadata_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_agent_run_messages_group_created").using("btree", table.spaceId.asc().nullsLast(), table.groupId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_agent_run_messages_run_created").using("btree", table.spaceId.asc().nullsLast(), table.runId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_agent_run_messages_sender_agent_created").using("btree", table.spaceId.asc().nullsLast(), table.senderAgentId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	foreignKey({
			columns: [table.groupId],
			foreignColumns: [agentRunGroups.id],
			name: "agent_run_messages_group_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentMessageId],
			foreignColumns: [table.id],
			name: "agent_run_messages_parent_message_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "agent_run_messages_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.senderAgentId],
			foreignColumns: [agents.id],
			name: "agent_run_messages_sender_agent_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.senderUserId],
			foreignColumns: [users.id],
			name: "agent_run_messages_sender_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "agent_run_messages_space_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.groupId, table.spaceId],
			foreignColumns: [agentRunGroups.id, agentRunGroups.spaceId],
			name: "fk_agent_run_messages_group_same_space"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentMessageId, table.spaceId],
			foreignColumns: [table.id, table.spaceId],
			name: "fk_agent_run_messages_parent_same_space"
		}),
	foreignKey({
			columns: [table.runId, table.spaceId],
			foreignColumns: [runs.id, runs.spaceId],
			name: "fk_agent_run_messages_run_same_space"
		}),
	foreignKey({
			columns: [table.senderAgentId, table.spaceId],
			foreignColumns: [agents.id, agents.spaceId],
			name: "fk_agent_run_messages_sender_agent_same_space"
		}),
	unique("uq_agent_run_messages_space_id_id").on(table.id, table.spaceId),
	check("ck_agent_run_messages_message_type", sql`(message_type)::text = ANY (ARRAY[('user_instruction'::character varying)::text, ('agent_message'::character varying)::text, ('delegation_request'::character varying)::text, ('delegation_result'::character varying)::text, ('system_event'::character varying)::text, ('review_note'::character varying)::text])`),
]);

export const runDelegations = pgTable("run_delegations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	groupId: varchar("group_id", { length: 36 }).notNull(),
	parentRunId: varchar("parent_run_id", { length: 36 }).notNull(),
	childRunId: varchar("child_run_id", { length: 36 }),
	requestMessageId: varchar("request_message_id", { length: 36 }),
	requestingAgentId: varchar("requesting_agent_id", { length: 36 }).notNull(),
	targetAgentId: varchar("target_agent_id", { length: 36 }).notNull(),
	requestedByUserId: varchar("requested_by_user_id", { length: 36 }),
	policyDecisionRecordId: varchar("policy_decision_record_id", { length: 36 }),
	status: varchar({ length: 32 }).notNull(),
	instruction: text().notNull(),
	reason: text(),
	budgetJson: jsonb("budget_json"),
	contextPolicyJson: jsonb("context_policy_json"),
	resultSummary: text("result_summary"),
	toolCallId: varchar("tool_call_id", { length: 128 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("uq_run_delegations_parent_tool_call").using("btree", table.spaceId.asc().nullsLast(), table.parentRunId.asc().nullsLast(), table.toolCallId.asc().nullsLast()).where(sql`(tool_call_id IS NOT NULL)`),
	index("ix_run_delegations_child_run").using("btree", table.spaceId.asc().nullsLast(), table.childRunId.asc().nullsLast()),
	index("ix_run_delegations_group_created").using("btree", table.spaceId.asc().nullsLast(), table.groupId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_run_delegations_parent_run").using("btree", table.spaceId.asc().nullsLast(), table.parentRunId.asc().nullsLast()),
	index("ix_run_delegations_requesting_agent_created").using("btree", table.spaceId.asc().nullsLast(), table.requestingAgentId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_run_delegations_status_updated").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	index("ix_run_delegations_target_agent_created").using("btree", table.spaceId.asc().nullsLast(), table.targetAgentId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	foreignKey({
			columns: [table.childRunId],
			foreignColumns: [runs.id],
			name: "run_delegations_child_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.groupId],
			foreignColumns: [agentRunGroups.id],
			name: "run_delegations_group_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentRunId],
			foreignColumns: [runs.id],
			name: "run_delegations_parent_run_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.policyDecisionRecordId],
			foreignColumns: [policyDecisionRecords.id],
			name: "run_delegations_policy_decision_record_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.requestMessageId],
			foreignColumns: [agentRunMessages.id],
			name: "run_delegations_request_message_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.requestedByUserId],
			foreignColumns: [users.id],
			name: "run_delegations_requested_by_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.requestingAgentId],
			foreignColumns: [agents.id],
			name: "run_delegations_requesting_agent_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "run_delegations_space_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.targetAgentId],
			foreignColumns: [agents.id],
			name: "run_delegations_target_agent_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.childRunId, table.spaceId],
			foreignColumns: [runs.id, runs.spaceId],
			name: "fk_run_delegations_child_run_same_space"
		}),
	foreignKey({
			columns: [table.groupId, table.spaceId],
			foreignColumns: [agentRunGroups.id, agentRunGroups.spaceId],
			name: "fk_run_delegations_group_same_space"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentRunId, table.spaceId],
			foreignColumns: [runs.id, runs.spaceId],
			name: "fk_run_delegations_parent_run_same_space"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.policyDecisionRecordId, table.spaceId],
			foreignColumns: [policyDecisionRecords.id, policyDecisionRecords.spaceId],
			name: "fk_run_delegations_policy_decision_same_space"
		}),
	foreignKey({
			columns: [table.requestMessageId, table.spaceId],
			foreignColumns: [agentRunMessages.id, agentRunMessages.spaceId],
			name: "fk_run_delegations_request_message_same_space"
		}),
	foreignKey({
			columns: [table.requestingAgentId, table.spaceId],
			foreignColumns: [agents.id, agents.spaceId],
			name: "fk_run_delegations_requesting_agent_same_space"
		}),
	foreignKey({
			columns: [table.targetAgentId, table.spaceId],
			foreignColumns: [agents.id, agents.spaceId],
			name: "fk_run_delegations_target_agent_same_space"
		}),
	unique("uq_run_delegations_space_id_id").on(table.id, table.spaceId),
	check("ck_run_delegations_status", sql`(status)::text = ANY (ARRAY[('requested'::character varying)::text, ('policy_denied'::character varying)::text, ('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text])`),
]);
