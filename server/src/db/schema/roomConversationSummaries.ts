import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { rooms } from "./rooms";
import { projects } from "./projects";
import { sessions } from "./sessions";
import { spaces } from "./spaces";
import { users } from "./auth";

/** Append-only, member-visible rolling summaries for Room conversations. */
export const roomConversationSummaryVersions = pgTable("room_conversation_summary_versions", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  sessionId: varchar("session_id", { length: 36 }).notNull(),
  version: integer().notNull(),
  status: varchar({ length: 16 }).notNull(),
  summaryText: text("summary_text").notNull(),
  coveredThroughMessageId: varchar("covered_through_message_id", { length: 36 }).notNull(),
  coveredThroughCreatedAt: timestamp("covered_through_created_at", { withTimezone: true, mode: "string" }).notNull(),
  coveredMessageCount: integer("covered_message_count").notNull(),
  sourceTokenEstimate: integer("source_token_estimate").notNull(),
  summaryTokenEstimate: integer("summary_token_estimate").notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(),
  ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
  providerId: varchar("provider_id", { length: 36 }),
  model: varchar({ length: 256 }),
  usageJson: jsonb("usage_json").notNull().default({}),
  auditJson: jsonb("audit_json").notNull().default({}),
  systemPromptVersion: varchar("system_prompt_version", { length: 128 }).notNull(),
  schemaVersion: varchar("schema_version", { length: 128 }).notNull(),
  supersedesId: varchar("supersedes_id", { length: 36 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_room_conversation_summary_versions_session_version").on(table.sessionId, table.version),
  unique("uq_room_conversation_summary_versions_scope").on(table.id, table.sessionId, table.roomId, table.spaceId),
  uniqueIndex("uq_room_conversation_summary_versions_active").on(table.sessionId)
    .where(sql`status = 'active'`),
  index("ix_room_conversation_summary_versions_room_created").on(table.spaceId, table.roomId, table.createdAt),
  foreignKey({
    columns: [table.roomId, table.spaceId],
    foreignColumns: [rooms.id, rooms.spaceId],
    name: "room_conversation_summary_versions_room_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.projectId, table.spaceId],
    foreignColumns: [projects.id, projects.spaceId],
    name: "room_conversation_summary_versions_project_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.sessionId, table.spaceId],
    foreignColumns: [sessions.id, sessions.spaceId],
    name: "room_conversation_summary_versions_session_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.spaceId],
    foreignColumns: [spaces.id],
    name: "room_conversation_summary_versions_space_id_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.ownerUserId],
    foreignColumns: [users.id],
    name: "room_conversation_summary_versions_owner_user_id_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.supersedesId],
    foreignColumns: [table.id],
    name: "room_conversation_summary_versions_supersedes_id_fkey",
  }).onDelete("restrict"),
  check("ck_room_conversation_summary_versions_status", sql`status IN ('active','superseded')`),
  check("ck_room_conversation_summary_versions_coverage", sql`version >= 1 AND covered_message_count >= 1 AND source_token_estimate >= 0 AND summary_token_estimate >= 0 AND char_length(summary_text) >= 1`),
  check("ck_room_conversation_summary_versions_json", sql`jsonb_typeof(usage_json) = 'object' AND jsonb_typeof(audit_json) = 'object'`),
]);

/** Mutable scheduling/lease state; summary versions themselves remain immutable. */
export const roomConversationSummaryStates = pgTable("room_conversation_summary_states", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  sessionId: varchar("session_id", { length: 36 }).notNull(),
  status: varchar({ length: 24 }).notNull(),
  activeSummaryId: varchar("active_summary_id", { length: 36 }),
  requestedThroughMessageId: varchar("requested_through_message_id", { length: 36 }),
  requestedThroughCreatedAt: timestamp("requested_through_created_at", { withTimezone: true, mode: "string" }),
  leaseToken: varchar("lease_token", { length: 36 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
  retryCount: integer("retry_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: "string" }),
  lastError: varchar("last_error", { length: 2000 }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_room_conversation_summary_states_session").on(table.sessionId),
  index("ix_room_conversation_summary_states_due").on(table.status, table.nextAttemptAt),
  foreignKey({
    columns: [table.roomId, table.spaceId],
    foreignColumns: [rooms.id, rooms.spaceId],
    name: "room_conversation_summary_states_room_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.sessionId, table.spaceId],
    foreignColumns: [sessions.id, sessions.spaceId],
    name: "room_conversation_summary_states_session_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.spaceId],
    foreignColumns: [spaces.id],
    name: "room_conversation_summary_states_space_id_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.activeSummaryId, table.sessionId, table.roomId, table.spaceId],
    foreignColumns: [roomConversationSummaryVersions.id, roomConversationSummaryVersions.sessionId, roomConversationSummaryVersions.roomId, roomConversationSummaryVersions.spaceId],
    name: "room_conversation_summary_states_active_summary_fkey",
  }).onDelete("restrict"),
  check("ck_room_conversation_summary_states_status", sql`status IN ('idle','queued','running','waiting_provider','retry_wait','failed')`),
  check("ck_room_conversation_summary_states_retry", sql`retry_count >= 0`),
  check("ck_room_conversation_summary_states_lease", sql`(lease_token IS NULL AND lease_expires_at IS NULL) OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)`),
]);
