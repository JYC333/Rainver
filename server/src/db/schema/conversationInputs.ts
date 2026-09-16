import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { sessions, messages } from "./sessions.js";
import { projectFolders } from "./projectFolders.js";
import { workspaceLocations } from "./workspaceLocations.js";
import { runs } from "./runs.js";

/** Short-lived upload rows. The file is not visible until a message claims it. */
export const conversationInputMedia = pgTable("conversation_input_media", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
  filename: varchar({ length: 512 }).notNull(),
  mediaType: varchar("media_type", { length: 128 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: varchar({ length: 64 }).notNull(),
  storagePath: text("storage_path").notNull(),
  lifecycle: varchar({ length: 16 }).notNull().default("pending"),
  messageId: varchar("message_id", { length: 36 }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_conversation_input_media_owner").on(table.spaceId, table.ownerUserId, table.createdAt),
  index("ix_conversation_input_media_expiry").on(table.lifecycle, table.expiresAt),
  unique("uq_conversation_input_media_id_space").on(table.id, table.spaceId),
  foreignKey({
    columns: [table.spaceId],
    foreignColumns: [spaces.id],
    name: "conversation_input_media_space_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.ownerUserId],
    foreignColumns: [users.id],
    name: "conversation_input_media_owner_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.messageId],
    foreignColumns: [messages.id],
    name: "conversation_input_media_message_scope_fkey",
  }).onDelete("set null"),
  check("ck_conversation_input_media_size", sql`byte_size > 0`),
  check("ck_conversation_input_media_lifecycle", sql`lifecycle IN ('pending', 'claimed', 'deleted')`),
]);

/** Immutable, bounded text captured from an authorized WorkspaceLocation. */
export const conversationFileSnapshots = pgTable("conversation_file_snapshots", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  sessionId: varchar("session_id", { length: 36 }).notNull(),
  messageId: varchar("message_id", { length: 36 }).notNull(),
  projectFolderId: varchar("project_folder_id", { length: 36 }).notNull(),
  workspaceLocationId: varchar("workspace_location_id", { length: 36 }).notNull(),
  relativePath: text("relative_path").notNull(),
  displayName: varchar("display_name", { length: 512 }).notNull(),
  mediaType: varchar("media_type", { length: 256 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: varchar({ length: 64 }).notNull(),
  content: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_conversation_file_snapshots_message").on(table.spaceId, table.messageId, table.id),
  unique("uq_conversation_file_snapshots_id_space").on(table.id, table.spaceId),
  foreignKey({
    columns: [table.sessionId, table.spaceId],
    foreignColumns: [sessions.id, sessions.spaceId],
    name: "conversation_file_snapshots_session_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.messageId, table.spaceId, table.sessionId],
    foreignColumns: [messages.id, messages.spaceId, messages.sessionId],
    name: "conversation_file_snapshots_message_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.projectFolderId, table.spaceId],
    foreignColumns: [projectFolders.id, projectFolders.spaceId],
    name: "conversation_file_snapshots_folder_scope_fkey",
  }),
  foreignKey({
    columns: [table.workspaceLocationId, table.projectFolderId],
    foreignColumns: [workspaceLocations.id, workspaceLocations.projectFolderId],
    name: "conversation_file_snapshots_location_scope_fkey",
  }),
  check("ck_conversation_file_snapshots_size", sql`byte_size >= 0`),
]);

/** One normalized, ordered part owned by one message. */
export const messageInputParts = pgTable("message_input_parts", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  sessionId: varchar("session_id", { length: 36 }).notNull(),
  messageId: varchar("message_id", { length: 36 }).notNull(),
  position: integer().notNull(),
  kind: varchar({ length: 32 }).notNull(),
  mediaId: varchar("media_id", { length: 36 }),
  fileSnapshotId: varchar("file_snapshot_id", { length: 36 }),
  projectFolderId: varchar("project_folder_id", { length: 36 }),
  workspaceLocationId: varchar("workspace_location_id", { length: 36 }),
  relativePath: text("relative_path"),
  displayName: varchar("display_name", { length: 512 }).notNull(),
  mediaType: varchar("media_type", { length: 256 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: varchar({ length: 64 }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_message_input_parts_message").on(table.spaceId, table.messageId, table.position),
  unique("uq_message_input_parts_message_position").on(table.messageId, table.position),
  foreignKey({
    columns: [table.messageId, table.spaceId, table.sessionId],
    foreignColumns: [messages.id, messages.spaceId, messages.sessionId],
    name: "message_input_parts_message_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.mediaId, table.spaceId],
    foreignColumns: [conversationInputMedia.id, conversationInputMedia.spaceId],
    name: "message_input_parts_media_scope_fkey",
  }),
  foreignKey({
    columns: [table.fileSnapshotId, table.spaceId],
    foreignColumns: [conversationFileSnapshots.id, conversationFileSnapshots.spaceId],
    name: "message_input_parts_snapshot_scope_fkey",
  }),
  check("ck_message_input_parts_kind", sql`kind IN ('image', 'file_reference')`),
  check("ck_message_input_parts_position", sql`position >= 0`),
  check("ck_message_input_parts_size", sql`byte_size >= 0`),
  check("ck_message_input_parts_reference", sql`
    (kind = 'image'
      AND media_id IS NOT NULL
      AND file_snapshot_id IS NULL
      AND project_folder_id IS NULL
      AND workspace_location_id IS NULL
      AND relative_path IS NULL)
    OR (kind = 'file_reference'
      AND media_id IS NULL
      AND file_snapshot_id IS NOT NULL
      AND project_folder_id IS NOT NULL
      AND workspace_location_id IS NOT NULL
      AND relative_path IS NOT NULL)
  `),
]);

/** Client-stable admission key; the response is replayable without duplication. */
export const conversationTurnIdempotencies = pgTable("conversation_turn_idempotencies", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
  sessionId: varchar("session_id", { length: 36 }),
  messageId: varchar("message_id", { length: 36 }),
  runId: varchar("run_id", { length: 36 }),
  responseJson: text("response_json"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_conversation_turn_idempotencies_scope_key").on(table.spaceId, table.userId, table.idempotencyKey),
  index("ix_conversation_turn_idempotencies_run").on(table.spaceId, table.runId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "conversation_turn_idempotencies_space_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "conversation_turn_idempotencies_user_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.sessionId], foreignColumns: [sessions.id], name: "conversation_turn_idempotencies_session_scope_fkey" }).onDelete("set null"),
  foreignKey({ columns: [table.messageId], foreignColumns: [messages.id], name: "conversation_turn_idempotencies_message_scope_fkey" }).onDelete("set null"),
  foreignKey({ columns: [table.runId], foreignColumns: [runs.id], name: "conversation_turn_idempotencies_run_scope_fkey" }).onDelete("set null"),
]);
