import { pgTable, index, unique, check, foreignKey, varchar, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces.js";
import { extractionJobs } from "./sources.js";
import { sourceChannels } from "./sourceChannels.js";
import { projectSourceBindings } from "./projectSources.js";
import { projectOperations } from "./projectOperations.js";
import { users } from "./auth.js";
import { proposals } from "./proposals.js";

export const sourceBackfillPlans = pgTable("source_backfill_plans", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceChannelId: varchar("source_channel_id", { length: 36 }).notNull(),
	projectSourceBindingId: varchar("project_source_binding_id", { length: 36 }),
	projectOperationId: varchar("project_operation_id", { length: 36 }),
	requestedByUserId: varchar("requested_by_user_id", { length: 36 }),
	origin: varchar({ length: 24 }).notNull(),
	proposalId: varchar("proposal_id", { length: 36 }),
	strategyJson: jsonb("strategy_json").notNull(),
	quotaPolicyJson: jsonb("quota_policy_json").notNull(),
	status: varchar({ length: 24 }).notNull(),
	nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true, mode: 'string' }),
	segmentsTotal: integer("segments_total").default(0).notNull(),
	segmentsCompleted: integer("segments_completed").default(0).notNull(),
	segmentsFailed: integer("segments_failed").default(0).notNull(),
	itemsIngested: integer("items_ingested").default(0).notNull(),
	idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull(),
	errorJson: jsonb("error_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	index("ix_source_backfill_plans_channel_status").on(t.sourceChannelId, t.status),
	unique("uq_source_backfill_plans_idempotency").on(t.spaceId, t.idempotencyKey),
	unique("uq_source_backfill_plans_space_id_id").on(t.id, t.spaceId),
	foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "source_backfill_plans_space_fkey" }),
	foreignKey({ columns: [t.sourceChannelId, t.spaceId], foreignColumns: [sourceChannels.id, sourceChannels.spaceId], name: "source_backfill_plans_channel_fkey" }),
	foreignKey({ columns: [t.projectSourceBindingId, t.spaceId], foreignColumns: [projectSourceBindings.id, projectSourceBindings.spaceId], name: "source_backfill_plans_binding_fkey" }),
	foreignKey({ columns: [t.projectOperationId, t.spaceId], foreignColumns: [projectOperations.id, projectOperations.spaceId], name: "source_backfill_plans_operation_fkey" }),
	foreignKey({ columns: [t.requestedByUserId], foreignColumns: [users.id], name: "source_backfill_plans_user_fkey" }),
	foreignKey({ columns: [t.proposalId, t.spaceId], foreignColumns: [proposals.id, proposals.spaceId], name: "source_backfill_plans_proposal_fkey" }),
	check("ck_source_backfill_plans_origin", sql`origin IN ('user','agent_proposal','system')`),
	check("ck_source_backfill_plans_status", sql`status IN ('draft','proposed','approved','running','paused','completed','failed','cancelled')`),
]);

export const sourceBackfillSegments = pgTable("source_backfill_segments", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	planId: varchar("plan_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	seq: integer().notNull(),
	windowJson: jsonb("window_json").notNull(),
	status: varchar({ length: 16 }).notNull(),
	attemptCount: integer("attempt_count").default(0).notNull(),
	extractionJobId: varchar("extraction_job_id", { length: 36 }),
	itemsIngested: integer("items_ingested").default(0).notNull(),
	nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true, mode: 'string' }),
	errorJson: jsonb("error_json"),
}, (t): PgTableExtraConfigValue[] => [
	index("ix_source_backfill_segments_ready").on(t.spaceId, t.status, t.nextEligibleAt),
	unique("uq_source_backfill_segments_seq").on(t.planId, t.seq),
	foreignKey({ columns: [t.planId, t.spaceId], foreignColumns: [sourceBackfillPlans.id, sourceBackfillPlans.spaceId], name: "source_backfill_segments_plan_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.extractionJobId, t.spaceId], foreignColumns: [extractionJobs.id, extractionJobs.spaceId], name: "source_backfill_segments_job_fkey" }),
	check("ck_source_backfill_segments_status", sql`status IN ('pending','running','succeeded','failed','skipped')`),
	check("ck_source_backfill_segments_attempt", sql`attempt_count>=0`),
]);

export const sourceQuotaBuckets = pgTable("source_quota_buckets", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	scopeKind: varchar("scope_kind", { length: 24 }).notNull(),
	scopeKey: varchar("scope_key", { length: 256 }).notNull(),
	// "window" is a reserved SQL keyword (window functions); every raw-SQL
	// reference to this column must stay quoted or Postgres fails to parse it.
	window: varchar({ length: 16 }).notNull(),
	limitCount: integer("limit_count").notNull(),
	usedCount: integer("used_count").default(0).notNull(),
	windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: 'string' }).notNull(),
	resetAt: timestamp("reset_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	unique("uq_source_quota_buckets_scope").on(t.spaceId, t.scopeKind, t.scopeKey, t.window),
	foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "source_quota_buckets_space_fkey" }),
	check("ck_source_quota_buckets_scope", sql`scope_kind IN ('provider','connector','source_connection','source_channel')`),
	check("ck_source_quota_buckets_window", sql`"window" IN ('minute','hour','day')`),
	check("ck_source_quota_buckets_counts", sql`limit_count>0 AND used_count>=0`),
]);
