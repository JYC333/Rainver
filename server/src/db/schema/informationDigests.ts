import {
  pgTable,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
  varchar,
  integer,
  doublePrecision,
  jsonb,
  text,
  timestamp,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { interestTopics } from "./interestProfiles";
import { projects } from "./projects";
import { runs } from "./runs";
import { sourceItems } from "./sources";
import { sourceChannels } from "./sourceChannels";
import { spaces } from "./spaces";

/** One daily delivery snapshot for either one reader or one Project. */
export const informationDigests = pgTable("information_digests", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  digestType: varchar("digest_type", { length: 16 }).notNull(),
  ownerUserId: varchar("owner_user_id", { length: 36 }),
  projectId: varchar("project_id", { length: 36 }),
  digestDate: varchar("digest_date", { length: 10 }).notNull(),
  profileMaturity: varchar("profile_maturity", { length: 16 }),
  status: varchar({ length: 16 }).default("ready").notNull(),
  generatedByRunId: varchar("generated_by_run_id", { length: 36 }),
  settingsJson: jsonb("settings_json").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
  unique("uq_information_digests_id_space").on(t.id, t.spaceId),
  uniqueIndex("uq_information_digests_personal_day")
    .on(t.spaceId, t.ownerUserId, t.digestDate)
    .where(sql`digest_type = 'personal'`),
  uniqueIndex("uq_information_digests_project_day")
    .on(t.spaceId, t.projectId, t.digestDate)
    .where(sql`digest_type = 'project'`),
  index("ix_information_digests_personal_recent").on(t.spaceId, t.ownerUserId, t.digestDate),
  index("ix_information_digests_project_recent").on(t.spaceId, t.projectId, t.digestDate),
  foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "information_digests_space_fkey" }),
  foreignKey({ columns: [t.ownerUserId], foreignColumns: [users.id], name: "information_digests_owner_user_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.projectId, t.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "information_digests_project_fkey" }).onDelete("cascade"),
  // Single-column SET NULL: a composite FK would also null the non-null tenant
  // key when the provenance Run is deleted.
  foreignKey({ columns: [t.generatedByRunId], foreignColumns: [runs.id], name: "information_digests_run_fkey" }).onDelete("set null"),
  check("ck_information_digests_scope", sql`(digest_type = 'personal' AND owner_user_id IS NOT NULL AND project_id IS NULL) OR (digest_type = 'project' AND owner_user_id IS NULL AND project_id IS NOT NULL)`),
  check("ck_information_digests_date", sql`digest_date ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  check("ck_information_digests_maturity", sql`profile_maturity IS NULL OR profile_maturity IN ('cold','warming','warm')`),
  check("ck_information_digests_status", sql`status IN ('ready','empty','failed')`),
  check("ck_information_digests_settings", sql`jsonb_typeof(settings_json) = 'object'`),
]);

/** Private holding area for already discovered, outside-subscription items. */
export const informationDigestSerendipityPool = pgTable("information_digest_serendipity_pool", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
  sourceChannelId: varchar("source_channel_id", { length: 36 }),
  targetDomainKey: varchar("target_domain_key", { length: 64 }).notNull(),
  discoveryOrigin: varchar("discovery_origin", { length: 32 }).notNull(),
  status: varchar({ length: 16 }).default("standby").notNull(),
  probePeriod: varchar("probe_period", { length: 10 }),
  metadataJson: jsonb("metadata_json").default({}).notNull(),
  discoveredAt: timestamp("discovered_at", { withTimezone: true, mode: "string" }).notNull(),
  availableUntil: timestamp("available_until", { withTimezone: true, mode: "string" }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
}, (t): PgTableExtraConfigValue[] => [
  unique("uq_information_digest_serendipity_pool_user_item").on(t.spaceId, t.userId, t.sourceItemId),
  unique("uq_information_digest_serendipity_pool_id_space").on(t.id, t.spaceId),
  index("ix_information_digest_serendipity_pool_ready").on(t.spaceId, t.userId, t.status, t.availableUntil),
  index("ix_information_digest_serendipity_pool_domain").on(t.spaceId, t.userId, t.targetDomainKey),
  foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "information_digest_serendipity_pool_space_fkey" }),
  foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "information_digest_serendipity_pool_user_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.sourceItemId, t.spaceId], foreignColumns: [sourceItems.id, sourceItems.spaceId], name: "information_digest_serendipity_pool_item_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.sourceChannelId], foreignColumns: [sourceChannels.id], name: "information_digest_serendipity_pool_channel_fkey" }).onDelete("set null"),
  check("ck_information_digest_serendipity_pool_origin", sql`discovery_origin IN ('weekly_probe','source_recommendation')`),
  check("ck_information_digest_serendipity_pool_status", sql`status IN ('standby','consumed','expired')`),
  check("ck_information_digest_serendipity_pool_period", sql`probe_period IS NULL OR probe_period ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  check("ck_information_digest_serendipity_pool_metadata", sql`jsonb_typeof(metadata_json) = 'object'`),
]);

/** Audit and hard-budget ledger: one bounded probe per reader/week. */
export const informationDigestProbeRuns = pgTable("information_digest_probe_runs", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  periodStart: varchar("period_start", { length: 10 }).notNull(),
  status: varchar({ length: 16 }).notNull(),
  domainKeysJson: jsonb("domain_keys_json").default([]).notNull(),
  requestCount: integer("request_count").default(0).notNull(),
  resultCount: integer("result_count").default(0).notNull(),
  errorJson: jsonb("error_json"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
}, (t): PgTableExtraConfigValue[] => [
  unique("uq_information_digest_probe_runs_period").on(t.spaceId, t.userId, t.periodStart),
  index("ix_information_digest_probe_runs_recent").on(t.spaceId, t.userId, t.periodStart),
  foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "information_digest_probe_runs_space_fkey" }),
  foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "information_digest_probe_runs_user_fkey" }).onDelete("cascade"),
  check("ck_information_digest_probe_runs_period", sql`period_start ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  check("ck_information_digest_probe_runs_status", sql`status IN ('running','succeeded','degraded','failed','skipped')`),
  check("ck_information_digest_probe_runs_domains", sql`jsonb_typeof(domain_keys_json) = 'array'`),
  check("ck_information_digest_probe_runs_counts", sql`request_count BETWEEN 0 AND 3 AND result_count >= 0`),
]);

/** Owner-authored controls for the independent serendipity rotation state. */
export const informationDigestSerendipityDomainStates = pgTable("information_digest_serendipity_domain_states", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  domainKey: varchar("domain_key", { length: 64 }).notNull(),
  lastFeedback: varchar("last_feedback", { length: 16 }).notNull(),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true, mode: "string" }),
  blockedAt: timestamp("blocked_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
  unique("uq_information_digest_serendipity_domain_state").on(t.spaceId, t.userId, t.domainKey),
  index("ix_information_digest_serendipity_domain_state_active").on(t.spaceId, t.userId, t.blockedAt, t.cooldownUntil),
  foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "information_digest_serendipity_domain_state_space_fkey" }),
  foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "information_digest_serendipity_domain_state_user_fkey" }).onDelete("cascade"),
  check("ck_information_digest_serendipity_domain_state_feedback", sql`last_feedback IN ('interesting','neutral','never')`),
  check("ck_information_digest_serendipity_domain_state_block", sql`(last_feedback = 'never' AND blocked_at IS NOT NULL AND cooldown_until IS NULL) OR (last_feedback <> 'never' AND blocked_at IS NULL AND cooldown_until IS NOT NULL)`),
]);

/** Ranked membership plus the complete, inspectable attribution for each slot. */
export const informationDigestItems = pgTable("information_digest_items", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  digestId: varchar("digest_id", { length: 36 }).notNull(),
  sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
  section: varchar({ length: 24 }).default("interest").notNull(),
  position: integer().notNull(),
  quotaSlot: varchar("quota_slot", { length: 64 }).notNull(),
  matchedTopicId: varchar("matched_topic_id", { length: 36 }),
  serendipityPoolItemId: varchar("serendipity_pool_item_id", { length: 36 }),
  score: doublePrecision().notNull(),
  componentScoresJson: jsonb("component_scores_json").default({}).notNull(),
  rationale: text(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
  unique("uq_information_digest_items_position").on(t.digestId, t.position),
  unique("uq_information_digest_items_source").on(t.digestId, t.sourceItemId),
  index("ix_information_digest_items_digest_section").on(t.digestId, t.section, t.position),
  foreignKey({ columns: [t.digestId, t.spaceId], foreignColumns: [informationDigests.id, informationDigests.spaceId], name: "information_digest_items_digest_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.sourceItemId, t.spaceId], foreignColumns: [sourceItems.id, sourceItems.spaceId], name: "information_digest_items_source_fkey" }),
  foreignKey({ columns: [t.matchedTopicId], foreignColumns: [interestTopics.id], name: "information_digest_items_topic_fkey" }).onDelete("set null"),
  foreignKey({ columns: [t.serendipityPoolItemId], foreignColumns: [informationDigestSerendipityPool.id], name: "information_digest_items_serendipity_pool_fkey" }).onDelete("set null"),
  check("ck_information_digest_items_section", sql`section IN ('interest','serendipity')`),
  check("ck_information_digest_items_serendipity_origin", sql`(section = 'interest' AND serendipity_pool_item_id IS NULL) OR (section = 'serendipity' AND serendipity_pool_item_id IS NOT NULL)`),
  check("ck_information_digest_items_position", sql`position >= 0`),
  check("ck_information_digest_items_scores", sql`jsonb_typeof(component_scores_json) = 'object'`),
]);

/** One explicit, immutable three-state response per delivered serendipity item. */
export const informationDigestSerendipityFeedback = pgTable("information_digest_serendipity_feedback", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  digestItemId: varchar("digest_item_id", { length: 36 }).notNull(),
  domainKey: varchar("domain_key", { length: 64 }).notNull(),
  feedback: varchar({ length: 16 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
  unique("uq_information_digest_serendipity_feedback_item").on(t.digestItemId),
  index("ix_information_digest_serendipity_feedback_owner").on(t.spaceId, t.userId, t.createdAt),
  foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "information_digest_serendipity_feedback_space_fkey" }),
  foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "information_digest_serendipity_feedback_user_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.digestItemId], foreignColumns: [informationDigestItems.id], name: "information_digest_serendipity_feedback_item_fkey" }).onDelete("cascade"),
  check("ck_information_digest_serendipity_feedback_value", sql`feedback IN ('interesting','neutral','never')`),
]);
