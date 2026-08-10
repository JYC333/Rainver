import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { artifacts } from "./artifacts";
import { spaces } from "./spaces";

export const crossSpaceRetrievalSessions = pgTable("cross_space_retrieval_sessions", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  personalSpaceId: varchar("personal_space_id", { length: 36 }).notNull(),
  query: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "cross_space_retrieval_sessions_user_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.personalSpaceId], foreignColumns: [spaces.id], name: "cross_space_retrieval_sessions_personal_space_id_fkey" }).onDelete("cascade"),
  unique("uq_cross_space_retrieval_sessions_id_user").on(table.id, table.userId),
  index("ix_cross_space_retrieval_sessions_user").on(table.userId, table.createdAt),
]);

export const crossSpaceRetrievalPointers = pgTable("cross_space_retrieval_pointers", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  sessionId: varchar("session_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  resourceSpaceId: varchar("resource_space_id", { length: 36 }).notNull(),
  resourceType: varchar("resource_type", { length: 64 }).notNull(),
  resourceId: varchar("resource_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.sessionId, table.userId], foreignColumns: [crossSpaceRetrievalSessions.id, crossSpaceRetrievalSessions.userId], name: "cross_space_retrieval_pointers_session_user_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.resourceSpaceId], foreignColumns: [spaces.id], name: "cross_space_retrieval_pointers_resource_space_id_fkey" }).onDelete("cascade"),
  unique("uq_cross_space_retrieval_pointer_session_resource").on(table.sessionId, table.resourceSpaceId, table.resourceType, table.resourceId),
  index("ix_cross_space_retrieval_pointers_user").on(table.userId, table.id),
  check("ck_cross_space_retrieval_pointers_resource_type", sql`resource_type ~ '^[a-z][a-z0-9_]{0,63}$'`),
]);

export const crossSpaceEgressDisclosures = pgTable("cross_space_egress_disclosures", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  personalSpaceId: varchar("personal_space_id", { length: 36 }).notNull(),
  pointerIdsJson: jsonb("pointer_ids_json").notNull(),
  settingsSnapshotJson: jsonb("settings_snapshot_json").notNull(),
  disclosedAt: timestamp("disclosed_at", { withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "cross_space_egress_disclosures_user_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.personalSpaceId], foreignColumns: [spaces.id], name: "cross_space_egress_disclosures_personal_space_id_fkey" }).onDelete("cascade"),
  index("ix_cross_space_egress_disclosures_user").on(table.userId, table.expiresAt),
]);

export const contentEgressRecords = pgTable("content_egress_records", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  sourceSpaceId: varchar("source_space_id", { length: 36 }).notNull(),
  actorUserId: varchar("actor_user_id", { length: 36 }).notNull(),
  targetPersonalSpaceId: varchar("target_personal_space_id", { length: 36 }).notNull(),
  targetArtifactId: varchar("target_artifact_id", { length: 36 }).notNull(),
  disclosureId: varchar("disclosure_id", { length: 36 }).notNull(),
  sourcePointersJson: jsonb("source_pointers_json").notNull(),
  notificationEnabled: boolean("notification_enabled").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.sourceSpaceId], foreignColumns: [spaces.id], name: "content_egress_records_source_space_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.actorUserId], foreignColumns: [users.id], name: "content_egress_records_actor_user_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.targetPersonalSpaceId], foreignColumns: [spaces.id], name: "content_egress_records_target_personal_space_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.targetArtifactId, table.targetPersonalSpaceId], foreignColumns: [artifacts.id, artifacts.spaceId], name: "content_egress_records_target_artifact_space_fkey" }).onDelete("restrict"),
  foreignKey({ columns: [table.disclosureId], foreignColumns: [crossSpaceEgressDisclosures.id], name: "content_egress_records_disclosure_id_fkey" }).onDelete("restrict"),
  index("ix_content_egress_records_source_space").on(table.sourceSpaceId, table.createdAt),
]);

export const spaceMemberNotifications = pgTable("space_member_notifications", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  recipientUserId: varchar("recipient_user_id", { length: 36 }).notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  pointerMetadataJson: jsonb("pointer_metadata_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "space_member_notifications_space_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.recipientUserId], foreignColumns: [users.id], name: "space_member_notifications_recipient_user_id_fkey" }).onDelete("cascade"),
  index("ix_space_member_notifications_recipient").on(table.recipientUserId, table.createdAt),
  check("ck_space_member_notifications_event_type", sql`event_type IN ('egress_notification_setting_changed', 'content_egress')`),
]);
