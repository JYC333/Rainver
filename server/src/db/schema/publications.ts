import {
  pgTable,
  index,
  unique,
  check,
  foreignKey,
  varchar,
  integer,
  jsonb,
  timestamp,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";

export const contentPublications = pgTable("content_publications", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  sourceSpaceId: varchar("source_space_id", { length: 36 }).notNull(),
  sourceResourceType: varchar("source_resource_type", { length: 64 }).notNull(),
  sourceResourceId: varchar("source_resource_id", { length: 36 }).notNull(),
  version: integer().notNull(),
  snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
  snapshotJson: jsonb("snapshot_json").notNull(),
  snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
  publishedByUserId: varchar("published_by_user_id", { length: 36 }).notNull(),
  status: varchar({ length: 32 }).default("active").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  revokedByUserId: varchar("revoked_by_user_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_content_publications_source").using(
    "btree",
    table.sourceSpaceId.asc().nullsLast(),
    table.sourceResourceType.asc().nullsLast(),
    table.sourceResourceId.asc().nullsLast(),
  ),
  index("ix_content_publications_status").using("btree", table.status.asc().nullsLast()),
  unique("uq_content_publications_source_version").on(
    table.sourceSpaceId,
    table.sourceResourceType,
    table.sourceResourceId,
    table.version,
  ),
  foreignKey({
    columns: [table.sourceSpaceId],
    foreignColumns: [spaces.id],
    name: "content_publications_source_space_id_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.publishedByUserId],
    foreignColumns: [users.id],
    name: "content_publications_published_by_user_id_fkey",
  }),
  foreignKey({
    columns: [table.revokedByUserId],
    foreignColumns: [users.id],
    name: "content_publications_revoked_by_user_id_fkey",
  }),
  check("ck_content_publications_status", sql`status IN ('active', 'revoked')`),
  check("ck_content_publications_snapshot_object", sql`jsonb_typeof(snapshot_json) = 'object'`),
  check("ck_content_publications_version", sql`version > 0`),
]);

export const contentPublicationTargets = pgTable("content_publication_targets", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  publicationId: varchar("publication_id", { length: 36 }).notNull(),
  targetSpaceId: varchar("target_space_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_content_publication_targets_space").using("btree", table.targetSpaceId.asc().nullsLast()),
  unique("uq_content_publication_targets_publication_space").on(table.publicationId, table.targetSpaceId),
  foreignKey({
    columns: [table.publicationId],
    foreignColumns: [contentPublications.id],
    name: "content_publication_targets_publication_id_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.targetSpaceId],
    foreignColumns: [spaces.id],
    name: "content_publication_targets_target_space_id_fkey",
  }).onDelete("cascade"),
]);

export const contentPublicationImports = pgTable("content_publication_imports", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  publicationId: varchar("publication_id", { length: 36 }).notNull(),
  targetSpaceId: varchar("target_space_id", { length: 36 }).notNull(),
  publicationVersion: integer("publication_version").notNull(),
  snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
  importedResourceType: varchar("imported_resource_type", { length: 64 }).notNull(),
  importedResourceId: varchar("imported_resource_id", { length: 36 }).notNull(),
  importedByUserId: varchar("imported_by_user_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_content_publication_imports_resource").using(
    "btree",
    table.targetSpaceId.asc().nullsLast(),
    table.importedResourceType.asc().nullsLast(),
    table.importedResourceId.asc().nullsLast(),
  ),
  unique("uq_content_publication_imports_publication_space").on(table.publicationId, table.targetSpaceId),
  foreignKey({
    columns: [table.publicationId],
    foreignColumns: [contentPublications.id],
    name: "content_publication_imports_publication_id_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.publicationId, table.targetSpaceId],
    foreignColumns: [contentPublicationTargets.publicationId, contentPublicationTargets.targetSpaceId],
    name: "content_publication_imports_target_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.targetSpaceId],
    foreignColumns: [spaces.id],
    name: "content_publication_imports_target_space_id_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.importedByUserId],
    foreignColumns: [users.id],
    name: "content_publication_imports_imported_by_user_id_fkey",
  }),
  check("ck_content_publication_imports_version", sql`publication_version > 0`),
]);
