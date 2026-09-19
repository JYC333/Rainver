import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { sessions, messages } from "./sessions.js";
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
  check("ck_conversation_file_snapshots_size", sql`byte_size >= 0`),
]);

/** Content-addressed immutable text shared by message-owned resources. */
export const conversationInputResourceBlobs = pgTable("conversation_input_resource_blobs", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }),
  ownerUserId: varchar("owner_user_id", { length: 36 }),
  sha256: varchar({ length: 64 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  lineCount: integer("line_count").notNull(),
  content: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_conversation_input_resource_blobs_space_created").on(table.spaceId, table.createdAt),
  // The Space-scoped key `conversation_input_resources` points at; a plain
  // primary key on `id` cannot satisfy that composite foreign key.
  unique("uq_conversation_input_resource_blobs_id_space").on(table.id, table.spaceId),
  uniqueIndex("uq_conversation_input_resource_blobs_project_hash").on(
    table.spaceId,
    table.projectId,
    table.sha256,
  ).where(sql`project_id IS NOT NULL`),
  uniqueIndex("uq_conversation_input_resource_blobs_owner_hash").on(
    table.spaceId,
    table.ownerUserId,
    table.sha256,
  ).where(sql`owner_user_id IS NOT NULL`),
  foreignKey({
    columns: [table.spaceId],
    foreignColumns: [spaces.id],
    name: "conversation_input_resource_blobs_space_fkey",
  }).onDelete("cascade"),
  check("ck_conversation_input_resource_blobs_scope", sql`
    (project_id IS NOT NULL AND owner_user_id IS NULL)
    OR (project_id IS NULL AND owner_user_id IS NOT NULL)
  `),
  check("ck_conversation_input_resource_blobs_hash", sql`sha256 ~ '^[a-f0-9]{64}$'`),
  check("ck_conversation_input_resource_blobs_size", sql`
    byte_size >= 0 AND byte_size <= 524288 AND octet_length(content) = byte_size
  `),
  check("ck_conversation_input_resource_blobs_line_count", sql`line_count >= 0`),
]);

/** One immutable message-owned reference to a content-addressed text blob. */
export const conversationInputResources = pgTable("conversation_input_resources", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  sessionId: varchar("session_id", { length: 36 }).notNull(),
  messageId: varchar("message_id", { length: 36 }).notNull(),
  blobId: varchar("blob_id", { length: 36 }).notNull(),
  sourceKind: varchar("source_kind", { length: 32 }).notNull(),
  sourceState: varchar("source_state", { length: 16 }).notNull(),
  projectId: varchar("project_id", { length: 36 }),
  projectFolderId: varchar("project_folder_id", { length: 36 }),
  workspaceLocationId: varchar("workspace_location_id", { length: 36 }),
  relativePath: text("relative_path"),
  displayName: varchar("display_name", { length: 512 }).notNull(),
  mediaType: varchar("media_type", { length: 256 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: varchar({ length: 64 }).notNull(),
  draftId: varchar("draft_id", { length: 36 }),
  draftVersion: integer("draft_version"),
  baseSha256: varchar("base_sha256", { length: 64 }),
  captureActorUserId: varchar("capture_actor_user_id", { length: 36 }),
  capturedAt: timestamp("captured_at", { withTimezone: true, mode: "string" }).notNull(),
  selectionStartLine: integer("selection_start_line"),
  selectionStartColumn: integer("selection_start_column"),
  selectionEndLine: integer("selection_end_line"),
  selectionEndColumn: integer("selection_end_column"),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_conversation_input_resources_message").on(table.spaceId, table.messageId, table.id),
  index("ix_conversation_input_resources_blob").on(table.spaceId, table.blobId),
  unique("uq_conversation_input_resources_id_space").on(table.id, table.spaceId),
  foreignKey({
    columns: [table.spaceId],
    foreignColumns: [spaces.id],
    name: "conversation_input_resources_space_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.sessionId, table.spaceId],
    foreignColumns: [sessions.id, sessions.spaceId],
    name: "conversation_input_resources_session_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.messageId, table.spaceId, table.sessionId],
    foreignColumns: [messages.id, messages.spaceId, messages.sessionId],
    name: "conversation_input_resources_message_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.blobId, table.spaceId],
    foreignColumns: [conversationInputResourceBlobs.id, conversationInputResourceBlobs.spaceId],
    name: "conversation_input_resources_blob_scope_fkey",
  }),
  foreignKey({
    columns: [table.captureActorUserId],
    foreignColumns: [users.id],
    name: "conversation_input_resources_capture_actor_fkey",
  }).onDelete("set null"),
  check("ck_conversation_input_resources_state", sql`source_state IN ('saved', 'draft')`),
  check("ck_conversation_input_resources_size", sql`byte_size >= 0 AND byte_size <= 524288`),
  check("ck_conversation_input_resources_hash", sql`sha256 ~ '^[a-f0-9]{64}$'`),
  check("ck_conversation_input_resources_draft", sql`
    (source_state = 'draft' AND draft_id IS NOT NULL AND draft_version IS NOT NULL AND draft_version > 0)
    OR (source_state = 'saved' AND draft_version IS NULL AND draft_id IS NULL)
  `),
  check("ck_conversation_input_resources_base_hash", sql`base_sha256 IS NULL OR base_sha256 ~ '^[a-f0-9]{64}$'`),
  check("ck_conversation_input_resources_selection", sql`
    (selection_start_line IS NULL AND selection_start_column IS NULL
      AND selection_end_line IS NULL AND selection_end_column IS NULL)
    OR (selection_start_line >= 1 AND selection_start_column >= 1
      AND selection_end_line >= selection_start_line
      AND (selection_end_line > selection_start_line
        OR selection_end_column >= selection_start_column)
      AND selection_end_column >= 1)
  `),
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
  resourceId: varchar("resource_id", { length: 36 }),
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
  foreignKey({
    columns: [table.resourceId, table.spaceId],
    foreignColumns: [conversationInputResources.id, conversationInputResources.spaceId],
    name: "message_input_parts_resource_scope_fkey",
  }),
  check("ck_message_input_parts_kind", sql`kind IN ('image', 'file_reference', 'input_resource')`),
  check("ck_message_input_parts_position", sql`position >= 0`),
  check("ck_message_input_parts_size", sql`byte_size >= 0`),
  check("ck_message_input_parts_reference", sql`
    (kind = 'image'
      AND media_id IS NOT NULL
      AND file_snapshot_id IS NULL
      AND resource_id IS NULL
      AND project_folder_id IS NULL
      AND workspace_location_id IS NULL
      AND relative_path IS NULL)
    OR (kind = 'file_reference'
      AND media_id IS NULL
      AND file_snapshot_id IS NOT NULL
      AND resource_id IS NULL
      AND project_folder_id IS NOT NULL
      AND workspace_location_id IS NOT NULL
      AND relative_path IS NOT NULL)
    OR (kind = 'input_resource'
      AND media_id IS NULL
      AND file_snapshot_id IS NULL
      AND resource_id IS NOT NULL
      AND project_folder_id IS NULL
      AND workspace_location_id IS NULL
      AND relative_path IS NULL)
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
