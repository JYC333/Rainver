import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, varchar, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";
import { runs } from "./runs";
import { sourceItems } from "./sources";
import { spaceObjects } from "./knowledge";

export const researchIntegrityAlerts = pgTable("research_integrity_alerts", {
  id: varchar({ length: 36 }).primaryKey().notNull(), spaceId: varchar("space_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(), sourceItemId: varchar("source_item_id", { length: 36 }),
  doi: varchar({ length: 512 }).notNull(), eventKey: varchar("event_key", { length: 64 }).notNull(),
  eventType: varchar("event_type", { length: 32 }).notNull(), source: varchar({ length: 64 }).notNull(),
  noticeDoi: varchar("notice_doi", { length: 512 }), detailJson: jsonb("detail_json").default({}).notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_research_integrity_alerts_event").on(table.spaceId, table.projectId, table.eventKey),
  index("ix_research_integrity_alerts_project_detected").on(table.spaceId, table.projectId, table.detectedAt),
  foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "research_integrity_alerts_project_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.sourceItemId], foreignColumns: [sourceItems.id], name: "research_integrity_alerts_source_item_delete_fkey" }).onDelete("set null"),
  foreignKey({ columns: [table.sourceItemId, table.spaceId], foreignColumns: [sourceItems.id, sourceItems.spaceId], name: "research_integrity_alerts_source_item_fkey" }),
  check("ck_research_integrity_alerts_event_type", sql`event_type IN ('retraction','correction','expression_of_concern','reinstatement')`),
  check("ck_research_integrity_alerts_detail_object", sql`jsonb_typeof(detail_json) = 'object'`),
]);

export const researchPaperCards = pgTable("research_paper_cards", {
  id: varchar({ length: 36 }).primaryKey().notNull(), spaceId: varchar("space_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(), sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
  objectId: varchar("object_id", { length: 36 }), whyMd: text("why_md").default("").notNull(), howMd: text("how_md").default("").notNull(),
  whatMd: text("what_md").default("").notNull(), provenanceJson: jsonb("provenance_json").default({}).notNull(),
  editedByUser: boolean("edited_by_user").default(false).notNull(), stance: varchar({ length: 24 }), comparisonDetail: text("comparison_detail"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_research_paper_cards_project_source").on(table.spaceId, table.projectId, table.sourceItemId),
  index("ix_research_paper_cards_project").on(table.spaceId, table.projectId),
  foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "research_paper_cards_project_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.sourceItemId, table.spaceId], foreignColumns: [sourceItems.id, sourceItems.spaceId], name: "research_paper_cards_source_item_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.objectId], foreignColumns: [spaceObjects.id], name: "research_paper_cards_object_delete_fkey" }).onDelete("set null"),
  foreignKey({ columns: [table.objectId, table.spaceId], foreignColumns: [spaceObjects.id, spaceObjects.spaceId], name: "research_paper_cards_object_fkey" }),
  check("ck_research_paper_cards_stance", sql`stance IS NULL OR stance IN ('supports','contradicts','new_direction')`),
]);

export const researchChecklistItems = pgTable("research_checklist_items", {
  id: varchar({ length: 36 }).primaryKey().notNull(), spaceId: varchar("space_id", { length: 36 }).notNull(), projectId: varchar("project_id", { length: 36 }).notNull(),
  text: text().notNull(), status: varchar({ length: 16 }).default("open").notNull(), sortOrder: integer("sort_order").notNull(),
  origin: varchar({ length: 16 }).notNull(), originRunId: varchar("origin_run_id", { length: 36 }), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_research_checklist_items_project_order").on(table.spaceId, table.projectId, table.sortOrder),
  foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "research_checklist_items_project_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.originRunId], foreignColumns: [runs.id], name: "research_checklist_items_run_delete_fkey" }).onDelete("set null"),
  foreignKey({ columns: [table.originRunId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "research_checklist_items_run_fkey" }),
  check("ck_research_checklist_items_status", sql`status IN ('open','done','dismissed')`),
  check("ck_research_checklist_items_origin", sql`origin IN ('user','agent')`),
  check("ck_research_checklist_items_sort", sql`sort_order >= 0`),
]);
