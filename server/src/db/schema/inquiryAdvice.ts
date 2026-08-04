import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { inquiryThreads } from "./inquiry";

/**
 * Model-generated advice about a Thread's next step. This is a suggestion
 * surface only: the recommendation never writes `inquiry_threads.next_focus_kind`
 * on its own — adopting it goes through the ordinary work-state command, which
 * keeps the Next Focus invariant and its work-event audit trail in one place.
 *
 * One row per Thread (the latest advice). `thread_version` pins the Thread
 * revision the advice reasoned about, so a reader can tell that a later
 * revision has made it stale rather than trusting a recommendation formed
 * against wording or a position that has since changed.
 */
export const inquiryThreadAdvice = pgTable("inquiry_thread_advice", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	threadId: varchar("thread_id", { length: 36 }).notNull(),
	recommendedFocusKind: varchar("recommended_focus_kind", { length: 32 }).notNull(),
	rationale: text().notNull(),
	// Ids of the Signals and Iterations the advice reasoned from, so the
	// recommendation can be checked against evidence the user can open.
	citedRefsJson: jsonb("cited_refs_json").default([]).notNull(),
	threadVersion: integer("thread_version").notNull(),
	status: varchar({ length: 16 }).default('open').notNull(),
	// How the advice came to exist: an explicit request, or the domain event
	// that made the previous advice worth replacing.
	triggerKind: varchar("trigger_kind", { length: 32 }).notNull(),
	modelVersion: varchar("model_version", { length: 64 }),
	generatedByUserId: varchar("generated_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_inquiry_thread_advice_project_id").using("btree", table.projectId.asc().nullsLast()),
	uniqueIndex("uq_inquiry_thread_advice_thread").using("btree", table.threadId.asc().nullsLast()),
	unique("uq_inquiry_thread_advice_id_space").on(table.id, table.spaceId),
	foreignKey({
			columns: [table.threadId, table.projectId, table.spaceId],
			foreignColumns: [inquiryThreads.id, inquiryThreads.projectId, inquiryThreads.spaceId],
			name: "inquiry_thread_advice_thread_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "inquiry_thread_advice_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "inquiry_thread_advice_space_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.generatedByUserId],
			foreignColumns: [users.id],
			name: "inquiry_thread_advice_generated_by_fkey"
		}).onDelete("set null"),
	check("ck_inquiry_thread_advice_status", sql`status IN ('open', 'adopted', 'dismissed')`),
	check("ck_inquiry_thread_advice_refs_array", sql`jsonb_typeof(cited_refs_json) = 'array'`),
	check("ck_inquiry_thread_advice_rationale", sql`char_length(rationale) BETWEEN 1 AND 4000`),
	check("ck_inquiry_thread_advice_version", sql`thread_version >= 1`),
]);
