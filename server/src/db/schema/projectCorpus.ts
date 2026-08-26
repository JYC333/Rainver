import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, doublePrecision, jsonb, boolean, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { extractedEvidence, spaceObjects } from "./knowledge.js";
import { projects } from "./projects.js";
import { sourceConnections, sourceItems, sourcePostProcessingItemDecisions } from "./sources.js";
import { spaces } from "./spaces.js";

export const projectCorpusItems = pgTable("project_corpus_items", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	objectId: varchar("object_id", { length: 36 }),
	sourceItemId: varchar("source_item_id", { length: 36 }),
	evidenceId: varchar("evidence_id", { length: 36 }),
	sourceConnectionId: varchar("source_connection_id", { length: 36 }),
	sourceDecisionId: varchar("source_decision_id", { length: 36 }),
	role: varchar({ length: 32 }).default("candidate").notNull(),
	status: varchar({ length: 32 }).default("active").notNull(),
	triageStatus: varchar("triage_status", { length: 32 }).default("new").notNull(),
	// Set true whenever a human explicitly sets triage_status through the
	// Project Corpus API (POST/PATCH). Automated screening-decision sync
	// (project_source_bindings-driven AI suggestions) must not overwrite
	// triage_status once this is true: AI screening may suggest decisions,
	// but the user confirms durable inclusion/exclusion.
	triageConfirmedByUser: boolean("triage_confirmed_by_user").default(false).notNull(),
	// Project/team review progress. Personal reading progress is owned solely by
	// source_item_user_states and is never synchronized with this field.
	readStatus: varchar("read_status", { length: 32 }).default("unread").notNull(),
	relevance: varchar({ length: 32 }),
	confidence: doublePrecision(),
	reason: text(),
	addedByUserId: varchar("added_by_user_id", { length: 36 }),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
	lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true, mode: "string" }),
	lastReadAt: timestamp("last_read_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_corpus_items_added_by_user_id").using("btree", table.addedByUserId.asc().nullsLast()),
	index("ix_project_corpus_items_evidence_id").using("btree", table.evidenceId.asc().nullsLast()),
	index("ix_project_corpus_items_object_id").using("btree", table.objectId.asc().nullsLast()),
	index("ix_project_corpus_items_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_project_corpus_items_project_role").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.role.asc().nullsLast()),
	index("ix_project_corpus_items_project_triage").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.triageStatus.asc().nullsLast()),
	index("ix_project_corpus_items_source_connection_id").using("btree", table.sourceConnectionId.asc().nullsLast()),
	index("ix_project_corpus_items_source_decision_id").using("btree", table.sourceDecisionId.asc().nullsLast()),
	index("ix_project_corpus_items_source_item_id").using("btree", table.sourceItemId.asc().nullsLast()),
	index("ix_project_corpus_items_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_corpus_items_status").using("btree", table.status.asc().nullsLast()),
	uniqueIndex("uq_project_corpus_items_project_evidence").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.evidenceId.asc().nullsLast()).where(sql`evidence_id IS NOT NULL`),
	uniqueIndex("uq_project_corpus_items_project_object").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.objectId.asc().nullsLast()).where(sql`object_id IS NOT NULL`),
	uniqueIndex("uq_project_corpus_items_project_source_item").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.sourceItemId.asc().nullsLast()).where(sql`source_item_id IS NOT NULL`),
	foreignKey({
			columns: [table.addedByUserId],
			foreignColumns: [users.id],
			name: "project_corpus_items_added_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.evidenceId, table.spaceId],
			foreignColumns: [extractedEvidence.id, extractedEvidence.spaceId],
			name: "project_corpus_items_evidence_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "project_corpus_items_object_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_corpus_items_project_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceConnectionId, table.spaceId],
			foreignColumns: [sourceConnections.id, sourceConnections.spaceId],
			name: "project_corpus_items_source_connection_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceDecisionId, table.spaceId],
			foreignColumns: [sourcePostProcessingItemDecisions.id, sourcePostProcessingItemDecisions.spaceId],
			name: "project_corpus_items_source_decision_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceItemId, table.spaceId],
			foreignColumns: [sourceItems.id, sourceItems.spaceId],
			name: "project_corpus_items_source_item_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_corpus_items_space_id_fkey"
		}),
	unique("uq_project_corpus_items_id_space_id").on(table.id, table.spaceId),
	unique("uq_project_corpus_items_id_project_space").on(table.id, table.projectId, table.spaceId),
	check("ck_project_corpus_items_confidence", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("ck_project_corpus_items_exactly_one_target", sql`num_nonnulls(object_id, source_item_id, evidence_id) = 1`),
	check("ck_project_corpus_items_metadata_object", sql`jsonb_typeof(metadata_json) = 'object'::text`),
	check("ck_project_corpus_items_read_status", sql`(read_status)::text = ANY (ARRAY[('unread'::character varying)::text, ('skimmed'::character varying)::text, ('read'::character varying)::text, ('discussed'::character varying)::text])`),
	check("ck_project_corpus_items_relevance", sql`(relevance IS NULL) OR ((relevance)::text = ANY (ARRAY[('relevant'::character varying)::text, ('maybe'::character varying)::text, ('not_relevant'::character varying)::text]))`),
	check("ck_project_corpus_items_role", sql`(role)::text = ANY (ARRAY[('candidate'::character varying)::text, ('reference'::character varying)::text, ('primary'::character varying)::text, ('related'::character varying)::text, ('background'::character varying)::text])`),
	check("ck_project_corpus_items_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_project_corpus_items_triage_status", sql`(triage_status)::text = ANY (ARRAY[('new'::character varying)::text, ('relevant'::character varying)::text, ('maybe'::character varying)::text, ('excluded'::character varying)::text, ('included'::character varying)::text])`),
]);

// Explicit project-authorized provenance. Corpus target identity remains
// exactly-one; this relation records only SourceItems that actually produced
// or were admitted into this project's Corpus item.
export const projectCorpusItemSources = pgTable("project_corpus_item_sources", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	corpusItemId: varchar("corpus_item_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_corpus_item_sources_source").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.sourceItemId.asc().nullsLast()),
	unique("uq_project_corpus_item_sources_item_source").on(table.corpusItemId, table.sourceItemId),
	foreignKey({
		columns: [table.corpusItemId, table.projectId, table.spaceId],
		foreignColumns: [projectCorpusItems.id, projectCorpusItems.projectId, projectCorpusItems.spaceId],
		name: "project_corpus_item_sources_corpus_item_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.sourceItemId, table.spaceId],
		foreignColumns: [sourceItems.id, sourceItems.spaceId],
		name: "project_corpus_item_sources_source_item_fkey",
	}),
]);
