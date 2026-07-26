import { pgTable, index, uniqueIndex, check, foreignKey, varchar, text, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./auth";
import { spaces } from "./spaces";
import { projectFolders } from "./projectFolders";

export const jobs = pgTable("jobs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	jobType: varchar("job_type", { length: 128 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	priority: integer().notNull(),
	payloadJson: jsonb("payload_json").notNull(),
	resultJson: jsonb("result_json"),
	error: text(),
	attempts: integer().notNull(),
	maxAttempts: integer("max_attempts").notNull(),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	claimedBy: varchar("claimed_by", { length: 64 }),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: 'string' }),
	userId: varchar("user_id", { length: 36 }),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	agentId: varchar("agent_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_jobs_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_jobs_claim_pending").using("btree", table.priority.desc().nullsFirst(), table.scheduledAt.asc().nullsLast()).where(sql`((status)::text = 'pending'::text)`),
	index("ix_jobs_job_type").using("btree", table.jobType.asc().nullsLast()),
	index("ix_jobs_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_jobs_status").using("btree", table.status.asc().nullsLast()),
	index("ix_jobs_type_claim_pending").using("btree", table.jobType.asc().nullsLast(), table.priority.desc().nullsFirst(), table.scheduledAt.asc().nullsLast()).where(sql`((status)::text = 'pending'::text)`),
	index("ix_jobs_user_id").using("btree", table.userId.asc().nullsLast()),
	index("ix_jobs_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	uniqueIndex("uq_jobs_session_condense_source_run").on(
		table.spaceId,
		sql`(payload_json->>'source_run_id')`,
	).where(sql`job_type = 'session_condense' AND payload_json->>'source_run_id' IS NOT NULL`),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "jobs_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "jobs_space_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "jobs_user_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "jobs_project_folder_id_fkey"
		}),
	check("ck_jobs_attempts_nonneg", sql`attempts >= 0`),
	check("ck_jobs_max_attempts_positive", sql`max_attempts > 0`),
	check("ck_jobs_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('claimed'::character varying)::text, ('running'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text])`),
]);

export const jobEvents = pgTable("job_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	jobId: varchar("job_id", { length: 36 }).notNull(),
	eventType: varchar("event_type", { length: 32 }).notNull(),
	message: text().notNull(),
	data: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_job_events_job_id").using("btree", table.jobId.asc().nullsLast()),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [jobs.id],
			name: "job_events_job_id_fkey"
		}),
]);
