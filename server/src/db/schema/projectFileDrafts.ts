import {
  check,
  foreignKey,
  index,
  integer,
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { projects } from "./projects.js";
import { projectFolders } from "./projectFolders.js";
import { workspaceLocations } from "./workspaceLocations.js";

/**
 * The one live recovery row for a human File-page edit. The Folder and its
 * Location remain the canonical physical authority; this row only protects
 * acknowledged unsaved text and is intentionally not a revision stream.
 */
export const projectFileDrafts = pgTable("project_file_drafts", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(),
  projectFolderId: varchar("project_folder_id", { length: 36 }).notNull(),
  workspaceLocationId: varchar("workspace_location_id", { length: 36 }).notNull(),
  ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
  targetKind: varchar("target_kind", { length: 16 }).notNull(),
  relativePath: text("relative_path").notNull(),
  baseExists: boolean("base_exists").notNull(),
  baseSha256: varchar("base_sha256", { length: 64 }),
  content: text().notNull(),
  contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  version: integer().notNull().default(1),
  sourceEncoding: varchar("source_encoding", { length: 16 }).notNull().default("utf8"),
  preserveBom: boolean("preserve_bom").notNull().default(false),
  lineEndingMode: varchar("line_ending_mode", { length: 8 }).notNull().default("lf"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_project_file_drafts_owner_updated").on(table.spaceId, table.ownerUserId, table.updatedAt),
  index("ix_project_file_drafts_expiry").on(table.expiresAt),
  uniqueIndex("uq_project_file_drafts_existing_path").on(
    table.spaceId,
    table.ownerUserId,
    table.workspaceLocationId,
    table.relativePath,
  ).where(sql`target_kind = 'existing'`),
  uniqueIndex("uq_project_file_drafts_new_file").on(
    table.spaceId,
    table.ownerUserId,
    table.workspaceLocationId,
  ).where(sql`target_kind = 'new'`),
  foreignKey({
    columns: [table.spaceId],
    foreignColumns: [spaces.id],
    name: "project_file_drafts_space_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.projectId, table.spaceId],
    foreignColumns: [projects.id, projects.spaceId],
    name: "project_file_drafts_project_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.projectFolderId, table.spaceId],
    foreignColumns: [projectFolders.id, projectFolders.spaceId],
    name: "project_file_drafts_folder_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.workspaceLocationId, table.projectFolderId],
    foreignColumns: [workspaceLocations.id, workspaceLocations.projectFolderId],
    name: "project_file_drafts_location_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.ownerUserId],
    foreignColumns: [users.id],
    name: "project_file_drafts_owner_fkey",
  }).onDelete("cascade"),
  check("ck_project_file_drafts_target_kind", sql`target_kind IN ('existing', 'new')`),
  check("ck_project_file_drafts_base_exists", sql`base_exists IN (true, false)`),
  check("ck_project_file_drafts_base_sha", sql`
    (base_exists = true AND base_sha256 ~ '^[a-f0-9]{64}$')
    OR (base_exists = false AND base_sha256 IS NULL)
  `),
  check("ck_project_file_drafts_size", sql`
    byte_size >= 0 AND byte_size <= 1048576 AND octet_length(content) = byte_size
  `),
  check("ck_project_file_drafts_content_sha", sql`content_sha256 ~ '^[a-f0-9]{64}$'`),
  check("ck_project_file_drafts_version", sql`version > 0`),
  check("ck_project_file_drafts_encoding", sql`source_encoding IN ('utf8', 'utf16le', 'utf16be')`),
  check("ck_project_file_drafts_bom", sql`preserve_bom IN (true, false)`),
  check("ck_project_file_drafts_line_endings", sql`line_ending_mode IN ('lf', 'crlf', 'mixed', 'none')`),
]);
