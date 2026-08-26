import { pgTable, index, uniqueIndex, check, foreignKey, varchar, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { users } from "./auth.js";
import { runs } from "./runs.js";
import { spaces } from "./spaces.js";
import { proposals } from "./proposals.js";

export const participationRecords = pgTable("participation_records", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	personalSpaceId: varchar("personal_space_id", { length: 36 }).notNull(),
	sourceSpaceId: varchar("source_space_id", { length: 36 }).notNull(),
	sourceObjectType: varchar("source_object_type", { length: 64 }).notNull(),
	sourceObjectId: varchar("source_object_id", { length: 36 }).notNull(),
	role: varchar({ length: 64 }).notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_participation_records_personal_space_id").using("btree", table.personalSpaceId.asc().nullsLast()),
	index("ix_participation_records_source").using("btree", table.sourceSpaceId.asc().nullsLast(), table.sourceObjectType.asc().nullsLast(), table.sourceObjectId.asc().nullsLast()),
	index("ix_participation_records_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.personalSpaceId],
			foreignColumns: [spaces.id],
			name: "participation_records_personal_space_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceSpaceId],
			foreignColumns: [spaces.id],
			name: "participation_records_source_space_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "participation_records_user_id_fkey"
		}),
]);

export const personalMemoryGrantEvents = pgTable("personal_memory_grant_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	grantId: varchar("grant_id", { length: 36 }).notNull(),
	eventType: varchar("event_type", { length: 64 }).notNull(),
	actorUserId: varchar("actor_user_id", { length: 36 }),
	runId: varchar("run_id", { length: 36 }),
	proposalId: varchar("proposal_id", { length: 36 }),
	sourceSpaceId: varchar("source_space_id", { length: 36 }),
	targetSpaceId: varchar("target_space_id", { length: 36 }),
	metadataJson: jsonb("metadata_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_personal_memory_grant_events_actor_user_id").using("btree", table.actorUserId.asc().nullsLast()),
	index("ix_personal_memory_grant_events_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("ix_personal_memory_grant_events_grant_id").using("btree", table.grantId.asc().nullsLast()),
	index("ix_personal_memory_grant_events_run_id").using("btree", table.runId.asc().nullsLast()),
	foreignKey({
			columns: [table.actorUserId],
			foreignColumns: [users.id],
			name: "personal_memory_grant_events_actor_user_id_fkey"
		}),
	foreignKey({
			columns: [table.grantId],
			foreignColumns: [personalMemoryGrants.id],
			name: "personal_memory_grant_events_grant_id_fkey"
		}),
	foreignKey({
			columns: [table.proposalId],
			foreignColumns: [proposals.id],
			name: "personal_memory_grant_events_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "personal_memory_grant_events_run_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceSpaceId],
			foreignColumns: [spaces.id],
			name: "personal_memory_grant_events_source_space_id_fkey"
		}),
	foreignKey({
			columns: [table.targetSpaceId],
			foreignColumns: [spaces.id],
			name: "personal_memory_grant_events_target_space_id_fkey"
		}),
	check("ck_personal_memory_grant_events_event_type", sql`(event_type)::text = ANY (ARRAY[('created'::character varying)::text, ('previewed'::character varying)::text, ('consuming'::character varying)::text, ('used'::character varying)::text, ('revoked'::character varying)::text, ('expired'::character varying)::text, ('failed'::character varying)::text, ('denied'::character varying)::text, ('egress_proposal_created'::character varying)::text, ('egress_approved'::character varying)::text])`),
]);

export const personalMemoryGrants = pgTable("personal_memory_grants", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	grantingUserId: varchar("granting_user_id", { length: 36 }).notNull(),
	personalSpaceId: varchar("personal_space_id", { length: 36 }).notNull(),
	targetSpaceId: varchar("target_space_id", { length: 36 }).notNull(),
	targetRunId: varchar("target_run_id", { length: 36 }).notNull(),
	targetAgentId: varchar("target_agent_id", { length: 36 }),
	grantScope: varchar("grant_scope", { length: 32 }).notNull(),
	accessMode: varchar("access_mode", { length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	memoryFilterJson: jsonb("memory_filter_json"),
	readExpiresAt: timestamp("read_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	egressReviewExpiresAt: timestamp("egress_review_expires_at", { withTimezone: true, mode: 'string' }),
	consumeStartedAt: timestamp("consume_started_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	failedAt: timestamp("failed_at", { withTimezone: true, mode: 'string' }),
	failureStage: varchar("failure_stage", { length: 64 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_personal_memory_grants_granting_user_id").using("btree", table.grantingUserId.asc().nullsLast()),
	index("ix_personal_memory_grants_personal_space_id").using("btree", table.personalSpaceId.asc().nullsLast()),
	index("ix_personal_memory_grants_read_expires_at").using("btree", table.readExpiresAt.asc().nullsLast()),
	index("ix_personal_memory_grants_status").using("btree", table.status.asc().nullsLast()),
	index("ix_personal_memory_grants_target_run_id").using("btree", table.targetRunId.asc().nullsLast()),
	index("ix_personal_memory_grants_target_space_id").using("btree", table.targetSpaceId.asc().nullsLast()),
	uniqueIndex("ix_personal_memory_grants_unique_active_consuming").using("btree", table.grantingUserId.asc().nullsLast(), table.targetRunId.asc().nullsLast()).where(sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('consuming'::character varying)::text]))`),
	foreignKey({
			columns: [table.grantingUserId],
			foreignColumns: [users.id],
			name: "personal_memory_grants_granting_user_id_fkey"
		}),
	foreignKey({
			columns: [table.personalSpaceId],
			foreignColumns: [spaces.id],
			name: "personal_memory_grants_personal_space_id_fkey"
		}),
	foreignKey({
			columns: [table.targetAgentId],
			foreignColumns: [agents.id],
			name: "personal_memory_grants_target_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.targetRunId],
			foreignColumns: [runs.id],
			name: "personal_memory_grants_target_run_id_fkey"
		}),
	foreignKey({
			columns: [table.targetSpaceId],
			foreignColumns: [spaces.id],
			name: "personal_memory_grants_target_space_id_fkey"
		}),
	check("ck_personal_memory_grants_access_mode", sql`(access_mode)::text = 'summary_only'::text`),
	check("ck_personal_memory_grants_grant_scope", sql`(grant_scope)::text = 'run'::text`),
	check("ck_personal_memory_grants_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('consuming'::character varying)::text, ('used'::character varying)::text, ('revoked'::character varying)::text, ('expired'::character varying)::text, ('failed'::character varying)::text])`),
	check("ck_personal_memory_grants_target_agent_id_null", sql`target_agent_id IS NULL`),
]);
