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
import { users } from "./auth";
import { projects } from "./projects";
import { spaces } from "./spaces";

/** Immutable semantic input shared by discovery, screening, and synthesis. */
export const projectResearchContextVersions = pgTable("project_research_context_versions", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(),
  createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
  version: integer().notNull(),
  objective: text().notNull(),
  contextJson: jsonb("context_json").notNull(),
  assessmentJson: jsonb("assessment_json").default({}).notNull(),
  provenanceJson: jsonb("provenance_json").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_project_research_context_versions_project_created").on(table.spaceId, table.projectId, table.createdAt),
  uniqueIndex("uq_project_research_context_versions_project_version").on(table.spaceId, table.projectId, table.version),
  unique("uq_project_research_context_versions_id_space").on(table.id, table.spaceId),
  unique("uq_project_research_context_versions_id_project_space").on(table.id, table.projectId, table.spaceId),
  foreignKey({
    columns: [table.projectId, table.spaceId],
    foreignColumns: [projects.id, projects.spaceId],
    name: "project_research_context_versions_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.spaceId],
    foreignColumns: [spaces.id],
    name: "project_research_context_versions_space_fkey",
  }),
  foreignKey({
    columns: [table.createdByUserId],
    foreignColumns: [users.id],
    name: "project_research_context_versions_user_fkey",
  }),
  check("ck_project_research_context_versions_version", sql`version >= 1`),
  check("ck_project_research_context_versions_objective", sql`char_length(objective) BETWEEN 1 AND 2000`),
  check(
    "ck_project_research_context_versions_json",
    sql`jsonb_typeof(context_json)='object' AND jsonb_typeof(assessment_json)='object' AND jsonb_typeof(provenance_json)='object'`,
  ),
]);
