import { pgTable, index, uniqueIndex, check, foreignKey, varchar, text, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { users } from "./auth.js";
import { sessions } from "./sessions.js";
import { runs } from "./runs.js";
import { spaces } from "./spaces.js";
import { projectFolders } from "./projectFolders.js";
import { projects } from "./projects.js";
import { tasks } from "./tasks.js";

export const activityRecords = pgTable("activity_records", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceRunId: varchar("source_run_id", { length: 36 }),
	sessionId: varchar("session_id", { length: 36 }),
	userId: varchar("user_id", { length: 36 }),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	agentId: varchar("agent_id", { length: 36 }),
	sourceTaskId: varchar("source_task_id", { length: 36 }),
	sourceUrl: text("source_url"),
	activityType: varchar("activity_type", { length: 64 }).notNull(),
	title: varchar({ length: 512 }),
	content: text(),
	payloadJson: jsonb("payload_json").notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	status: varchar({ length: 32 }).default('raw').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	sourceKind: varchar("source_kind", { length: 64 }),
	sourceTrust: varchar("source_trust", { length: 32 }),
	sourceIntegrityJson: jsonb("source_integrity_json"),
	entityRefsJson: jsonb("entity_refs_json"),
	subjectUserId: varchar("subject_user_id", { length: 36 }),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	discardedAt: timestamp("discarded_at", { withTimezone: true, mode: 'string' }),
	visibility: varchar({ length: 32 }).default('space_shared').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	projectId: varchar("project_id", { length: 36 }),
	aggregateKey: varchar("aggregate_key", { length: 128 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_activity_records_activity_type").using("btree", table.activityType.asc().nullsLast()),
	index("ix_activity_records_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_activity_records_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_activity_records_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_activity_records_session_id").using("btree", table.sessionId.asc().nullsLast()),
	index("ix_activity_records_source_kind").using("btree", table.sourceKind.asc().nullsLast()),
	index("ix_activity_records_source_run_id").using("btree", table.sourceRunId.asc().nullsLast()),
	index("ix_activity_records_source_task_id").using("btree", table.sourceTaskId.asc().nullsLast()),
	index("ix_activity_records_source_trust").using("btree", table.sourceTrust.asc().nullsLast()),
	index("ix_activity_records_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_activity_records_status").using("btree", table.status.asc().nullsLast()),
	index("ix_activity_records_subject_user_id").using("btree", table.subjectUserId.asc().nullsLast()),
	index("ix_activity_records_user_id").using("btree", table.userId.asc().nullsLast()),
	index("ix_activity_records_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	uniqueIndex("uq_activity_records_space_aggregate_key").using("btree", table.spaceId.asc().nullsLast(), table.aggregateKey.asc().nullsLast()).where(sql`(aggregate_key IS NOT NULL)`),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "activity_records_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "activity_records_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [sessions.id],
			name: "activity_records_session_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceRunId],
			foreignColumns: [runs.id],
			name: "activity_records_source_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "activity_records_space_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "activity_records_user_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "activity_records_project_folder_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "activity_records_project_id_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "fk_activity_records_project_id_projects"
		}),
	foreignKey({
			columns: [table.sourceTaskId],
			foreignColumns: [tasks.id],
			name: "fk_activity_records_source_task_id_tasks"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.subjectUserId],
			foreignColumns: [users.id],
			name: "fk_activity_records_subject_user_id_users"
		}).onDelete("set null"),
	check("ck_activity_records_source_kind", sql`(source_kind IS NULL) OR ((source_kind)::text = ANY (ARRAY[('user_capture'::character varying)::text, ('chat_message'::character varying)::text, ('external_chat'::character varying)::text, ('file_import'::character varying)::text, ('web_capture'::character varying)::text, ('run_event'::character varying)::text, ('project_folder_event'::character varying)::text, ('system_event'::character varying)::text, ('external_source'::character varying)::text, ('source'::character varying)::text]))`),
	check("ck_activity_records_source_trust", sql`(source_trust IS NULL) OR ((source_trust)::text = ANY (ARRAY[('user_confirmed'::character varying)::text, ('internal_system'::character varying)::text, ('trusted_external'::character varying)::text, ('untrusted_external'::character varying)::text, ('agent_inferred'::character varying)::text]))`),
	check("ck_activity_records_status", sql`(status)::text = ANY (ARRAY[('raw'::character varying)::text, ('processed'::character varying)::text, ('proposals_generated'::character varying)::text, ('failed'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_activity_records_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_activity_records_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_activity_records_private_owner", sql`visibility = 'space_shared' OR owner_user_id IS NOT NULL`),
]);
