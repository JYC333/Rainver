import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { spaces } from "./spaces";
import { projects } from "./projects";
import { knowledgeItems } from "./knowledge";
import { domainChangeOutbox } from "./domainChangeOutbox";

// Knowledge Candidate extraction and revalidation. Scoped to
// the knowledge_items-backed candidate kinds (concept/lesson/procedure/
// decision/summary) for this vertical slice — Claim and Relation promotion
// already have their own extraction/review flows (claim_candidate_packet,
// relation_discovery_packet in modules/knowledge/) and are not retrofitted
// with a pinned source reference in this slice; see PROJECTS.md.
//
// Accepting a Candidate never writes knowledge_items directly — it creates a
// pending knowledge_create/knowledge_update proposal (payload carries
// pinned_source_ref, which the existing appliers in
// modules/knowledge/proposalApplier.ts stamp onto the row) so canonical
// promotion stays proposal-gated end to end.
export const knowledgePromotionReviewPackets = pgTable("knowledge_promotion_review_packets", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	status: varchar({ length: 16 }).default('open').notNull(),
	openedByUserId: varchar("opened_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_knowledge_promotion_review_packets_project_status").using("btree", table.projectId.asc().nullsLast(), table.status.asc().nullsLast()),
	unique("uq_knowledge_promotion_review_packets_id_space").on(table.id, table.spaceId),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "knowledge_promotion_review_packets_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "knowledge_promotion_review_packets_space_fkey" }),
	foreignKey({ columns: [table.openedByUserId], foreignColumns: [users.id], name: "knowledge_promotion_review_packets_opened_by_fkey" }).onDelete("cascade"),
	check("ck_knowledge_promotion_review_packets_status", sql`status IN ('open', 'closed')`),
]);

export const knowledgePromotionCandidates = pgTable("knowledge_promotion_candidates", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	// 'promotion': a brand-new Knowledge item. 'revalidation': the source
	// this Candidate is pinned to already produced supersedesKnowledgeItemId;
	// accepting creates a new version (knowledge_update), not a new item.
	trigger: varchar({ length: 16 }).notNull(),
	sourceKind: varchar("source_kind", { length: 32 }).notNull(),
	sourceId: varchar("source_id", { length: 36 }).notNull(),
	sourceRefJson: jsonb("source_ref_json").notNull(),
	candidateKind: varchar("candidate_kind", { length: 32 }).notNull(),
	proposedTitle: varchar("proposed_title", { length: 512 }).notNull(),
	proposedContent: text("proposed_content").notNull(),
	visibility: varchar({ length: 32 }).default('space_shared').notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	supersedesKnowledgeItemId: varchar("supersedes_knowledge_item_id", { length: 36 }),
	reviewPacketId: varchar("review_packet_id", { length: 36 }),
	status: varchar({ length: 16 }).default('pending').notNull(),
	createdProposalId: varchar("created_proposal_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	decidedByUserId: varchar("decided_by_user_id", { length: 36 }),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_knowledge_promotion_candidates_space_status").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_knowledge_promotion_candidates_supersedes").using("btree", table.supersedesKnowledgeItemId.asc().nullsLast()),
	unique("uq_knowledge_promotion_candidates_id_space_id").on(table.id, table.spaceId),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "knowledge_promotion_candidates_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "knowledge_promotion_candidates_space_id_fkey" }),
	foreignKey({ columns: [table.supersedesKnowledgeItemId, table.spaceId], foreignColumns: [knowledgeItems.objectId, knowledgeItems.spaceId], name: "knowledge_promotion_candidates_supersedes_fkey" }),
	foreignKey({ columns: [table.reviewPacketId, table.spaceId], foreignColumns: [knowledgePromotionReviewPackets.id, knowledgePromotionReviewPackets.spaceId], name: "knowledge_promotion_candidates_review_packet_fkey" }),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "knowledge_promotion_candidates_created_by_user_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.decidedByUserId], foreignColumns: [users.id], name: "knowledge_promotion_candidates_decided_by_user_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.ownerUserId], foreignColumns: [users.id], name: "knowledge_promotion_candidates_owner_user_id_fkey" }).onDelete("cascade"),
	check("ck_knowledge_promotion_candidates_trigger", sql`(trigger)::text = ANY (ARRAY[('promotion'::character varying)::text, ('revalidation'::character varying)::text])`),
	check("ck_knowledge_promotion_candidates_source_kind", sql`(source_kind)::text = ANY (ARRAY[('note'::character varying)::text, ('inquiry_thread'::character varying)::text, ('experiment_interpretation'::character varying)::text])`),
	check("ck_knowledge_promotion_candidates_kind", sql`(candidate_kind)::text = ANY (ARRAY[('concept'::character varying)::text, ('lesson'::character varying)::text, ('procedure'::character varying)::text, ('decision'::character varying)::text, ('summary'::character varying)::text])`),
	check("ck_knowledge_promotion_candidates_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('deferred'::character varying)::text, ('promoted'::character varying)::text, ('dismissed'::character varying)::text])`),
	check("ck_knowledge_promotion_candidates_revalidation_target", sql`(trigger)::text <> 'revalidation'::text OR supersedes_knowledge_item_id IS NOT NULL`),
	check("ck_knowledge_promotion_candidates_visibility", sql`visibility IN ('private', 'space_shared')`),
	check("ck_knowledge_promotion_candidates_private_owner", sql`visibility='space_shared' OR owner_user_id IS NOT NULL`),
]);

// One outcome per (Knowledge item, outbox event) — the idempotency guarantee
// behind "no_impact remains queryable audit and creates no review noise" and
// "consumers claim events idempotently."
export const knowledgeRevalidationOutcomes = pgTable("knowledge_revalidation_outcomes", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	knowledgeItemId: varchar("knowledge_item_id", { length: 36 }).notNull(),
	eventId: varchar("event_id", { length: 36 }).notNull(),
	outcome: varchar({ length: 24 }).notNull(),
	resultingCandidateId: varchar("resulting_candidate_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_knowledge_revalidation_outcomes_item").using("btree", table.spaceId.asc().nullsLast(), table.knowledgeItemId.asc().nullsLast()),
	uniqueIndex("uq_knowledge_revalidation_outcomes_item_event").using("btree", table.knowledgeItemId.asc().nullsLast(), table.eventId.asc().nullsLast()),
	foreignKey({ columns: [table.knowledgeItemId, table.spaceId], foreignColumns: [knowledgeItems.objectId, knowledgeItems.spaceId], name: "knowledge_revalidation_outcomes_item_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.eventId, table.spaceId], foreignColumns: [domainChangeOutbox.id, domainChangeOutbox.spaceId], name: "knowledge_revalidation_outcomes_event_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "knowledge_revalidation_outcomes_space_id_fkey" }),
	foreignKey({ columns: [table.resultingCandidateId, table.spaceId], foreignColumns: [knowledgePromotionCandidates.id, knowledgePromotionCandidates.spaceId], name: "knowledge_revalidation_outcomes_candidate_fkey" }),
	check("ck_knowledge_revalidation_outcomes_outcome", sql`(outcome)::text = ANY (ARRAY[('no_impact'::character varying)::text, ('candidate_created'::character varying)::text, ('already_superseded'::character varying)::text])`),
	check("ck_knowledge_revalidation_outcomes_candidate_pairing", sql`(outcome)::text <> 'candidate_created'::text OR resulting_candidate_id IS NOT NULL`),
]);
