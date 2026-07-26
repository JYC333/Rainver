import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { knowledgeItems } from "./knowledge";

// Learning is an independent global Domain with Project-contextual scope.
// `projectId` is nullable — NULL
// means a Space-global Objective, not tied to any one Project; Postgres
// MATCH SIMPLE (the default) skips FK enforcement whenever any referenced
// column is NULL, so a NULL projectId is never checked against `projects`.
export const learningObjectives = pgTable("learning_objectives", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	title: varchar({ length: 512 }).notNull(),
	description: text(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_learning_objectives_space_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	unique("uq_learning_objectives_id_space_id").on(table.id, table.spaceId),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "learning_objectives_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "learning_objectives_space_id_fkey" }),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "learning_objectives_created_by_user_id_fkey" }).onDelete("set null"),
	check("ck_learning_objectives_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
]);

// A durable card/exercise anchored to one confirmed, versioned Knowledge
// item (plan section 13.5: "durable cards/exercises should use stable,
// versioned Knowledge anchors", distinct from temporary Note-derived
// suggestions, which this Phase does not implement). `knowledgeItemVersion`
// is captured at creation time for provenance/display only — unlike Phase
// 7's pinned_source_ref, staleness revalidation against a later Knowledge
// version is not implemented in this pass (see plan doc scoping notes).
export const learningItems = pgTable("learning_items", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	objectiveId: varchar("objective_id", { length: 36 }),
	knowledgeItemId: varchar("knowledge_item_id", { length: 36 }).notNull(),
	knowledgeItemVersion: integer("knowledge_item_version").notNull(),
	itemKind: varchar("item_kind", { length: 16 }).default('card').notNull(),
	prompt: text().notNull(),
	answer: text().notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_learning_items_space_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	index("ix_learning_items_objective_id").using("btree", table.objectiveId.asc().nullsLast()),
	unique("uq_learning_items_id_space_id").on(table.id, table.spaceId),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "learning_items_project_fkey" }).onDelete("cascade"),
	// No ON DELETE SET NULL here: a composite FK that includes space_id must
	// never SET NULL (the tenant reference integrity test forbids any SET
	// NULL FK on the tenant column) — see inquiry_threads_primary_parent_fkey
	// for the same rule applied to a self-referential composite FK.
	// Objectives are never hard-deleted by this Phase's service, so this is
	// a defensive constraint, not a path the app takes.
	foreignKey({ columns: [table.objectiveId, table.spaceId], foreignColumns: [learningObjectives.id, learningObjectives.spaceId], name: "learning_items_objective_fkey" }),
	foreignKey({ columns: [table.knowledgeItemId, table.spaceId], foreignColumns: [knowledgeItems.objectId, knowledgeItems.spaceId], name: "learning_items_knowledge_item_fkey" }),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "learning_items_space_id_fkey" }),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "learning_items_created_by_user_id_fkey" }).onDelete("set null"),
	check("ck_learning_items_kind", sql`(item_kind)::text = ANY (ARRAY[('card'::character varying)::text, ('exercise'::character varying)::text])`),
]);

// Per-user mastery and scheduling, deliberately separate from the shared
// Learning Item content above (plan section 13.5's completion gate: "global
// Learning state remains per-user while shared Knowledge remains canonical
// content").
export const learningItemMastery = pgTable("learning_item_mastery", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	learningItemId: varchar("learning_item_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	masteryState: varchar("mastery_state", { length: 16 }).default('new').notNull(),
	correctStreak: integer("correct_streak").default(0).notNull(),
	lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true, mode: 'string' }),
	nextReviewAt: timestamp("next_review_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_learning_item_mastery_user_next_review").using("btree", table.userId.asc().nullsLast(), table.nextReviewAt.asc().nullsLast()),
	uniqueIndex("uq_learning_item_mastery_item_user").using("btree", table.learningItemId.asc().nullsLast(), table.userId.asc().nullsLast()),
	foreignKey({ columns: [table.learningItemId, table.spaceId], foreignColumns: [learningItems.id, learningItems.spaceId], name: "learning_item_mastery_item_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "learning_item_mastery_user_id_fkey" }),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "learning_item_mastery_space_id_fkey" }),
	check("ck_learning_item_mastery_state", sql`(mastery_state)::text = ANY (ARRAY[('new'::character varying)::text, ('learning'::character varying)::text, ('mastered'::character varying)::text])`),
]);
