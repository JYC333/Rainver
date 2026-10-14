import { pgTable, index, unique, check, foreignKey, varchar, text, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces.js";
import { sourceItems } from "./sources.js";
import { sourceChannels } from "./sourceChannels.js";
import { runs } from "./runs.js";

/**
 * Objective annotation of a SourceItem, produced by the system annotation pass.
 *
 * Space-scoped and shared, not per-user: what a piece of material *is* does not
 * depend on who is reading it. Per-user judgement stays in
 * `source_item_user_states`, and per-rule judgement stays in
 * `source_post_processing_item_decisions`. Keeping them apart is what lets the
 * cross-source layer rank for one reader off annotation another reader's rule
 * paid for.
 *
 * One row per item. `status` carries `pending` before the pass runs so a
 * missing row and an unannotatable item are distinguishable — a silently
 * unannotated item never reaches the recommendation pool, and that is the
 * hardest recommender failure to diagnose.
 */
export const sourceItemAnnotations = pgTable("source_item_annotations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
	/** Which channel's scan first queued this item, for diagnostics only. */
	sourceChannelId: varchar("source_channel_id", { length: 36 }),
	status: varchar({ length: 16 }).default('pending').notNull(),
	/** Domain skeleton key; NULL until a succeeded pass assigns one. */
	domainKey: varchar("domain_key", { length: 64 }),
	depth: varchar({ length: 24 }),
	genre: varchar({ length: 24 }),
	summary: text(),
	/** Objective claim target and conclusion direction; never reader relevance. */
	stanceTarget: varchar("stance_target", { length: 256 }),
	stanceTargetKey: varchar("stance_target_key", { length: 256 }),
	stancePolarity: varchar("stance_polarity", { length: 16 }),
	stanceConfidence: integer("stance_confidence"),
	/**
	 * Free-text topic phrases the model proposed for this item.
	 *
	 * A reader's interest profile may not exist when annotation first runs, and
	 * its topic axis stays empty for a new reader regardless. Storing the
	 * model's phrases lets controlled topic growth map them onto real topics
	 * later without re-reading every item through a model a second time.
	 */
	topicCandidatesJson: jsonb("topic_candidates_json").default([]).notNull(),
	/** Agent Run that produced this annotation, for provenance and cost audit. */
	annotationRunId: varchar("annotation_run_id", { length: 36 }),
	/**
	 * Attempts spent in the current failure episode. Bounded: three initial
	 * attempts and one automatic recovery round of three, six per episode
	 * (`retryPolicy.ts`). A manual retry after the budget is spent opens a
	 * new episode and starts the count over.
	 */
	attemptCount: integer("attempt_count").default(0).notNull(),
	/**
	 * Why a pending row is not runnable right now, or why a failed one
	 * stopped. `retry_scheduled` waits for `next_retry_at`; the condition
	 * reasons wait for the condition and consume no attempt;
	 * `budget_exhausted` is paused until a person retries.
	 */
	waitReason: varchar("wait_reason", { length: 32 }),
	/** When a scheduled retry becomes runnable; the countdown the notification shows. NULL while a condition is awaited. */
	nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: 'string' }),
	/** The failure episode this row belongs to: one notification per episode, updated until it clears. */
	episodeId: varchar("episode_id", { length: 36 }),
	errorJson: jsonb("error_json"),
	annotatedAt: timestamp("annotated_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	unique("uq_source_item_annotations_space_item").on(t.spaceId, t.sourceItemId),
	unique("uq_source_item_annotations_id_space").on(t.id, t.spaceId),
	// The queue scan: pending rows oldest first, within a space.
	index("ix_source_item_annotations_pending").on(t.spaceId, t.status, t.createdAt),
	// The sweep: runnable rows by retry time, and open episodes by reason.
	index("ix_source_item_annotations_retry").on(t.spaceId, t.status, t.nextRetryAt),
	index("ix_source_item_annotations_episode").on(t.spaceId, t.episodeId),
	// Coverage distribution reads: succeeded rows grouped by domain.
	index("ix_source_item_annotations_domain").on(t.spaceId, t.domainKey),
	index("ix_source_item_annotations_stance").on(t.spaceId, t.stanceTargetKey, t.stancePolarity),
	foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "source_item_annotations_space_fkey" }),
	foreignKey({ columns: [t.sourceItemId, t.spaceId], foreignColumns: [sourceItems.id, sourceItems.spaceId], name: "source_item_annotations_item_fkey" }).onDelete("cascade"),
	// Single-column, not (id, space_id): a SET NULL foreign key nulls *every*
	// column it covers, so a composite one would blank this row's tenant key
	// when a channel or run is deleted. Both are optional provenance pointers
	// and the tenant key is not — same shape as notes.updated_by_run_id and
	// research_integrity_alerts.source_item_id.
	foreignKey({ columns: [t.sourceChannelId], foreignColumns: [sourceChannels.id], name: "source_item_annotations_channel_fkey" }).onDelete("set null"),
	foreignKey({ columns: [t.annotationRunId], foreignColumns: [runs.id], name: "source_item_annotations_run_fkey" }).onDelete("set null"),
	check("ck_source_item_annotations_status", sql`status IN ('pending','succeeded','failed','skipped')`),
	check("ck_source_item_annotations_wait_reason", sql`wait_reason IS NULL OR wait_reason IN ('retry_scheduled','provider_unavailable','egress_denied','consent_missing','budget_exhausted')`),
	check("ck_source_item_annotations_wait_shape", sql`(wait_reason = 'retry_scheduled') = (next_retry_at IS NOT NULL)`),
	check("ck_source_item_annotations_wait_status", sql`wait_reason IS NULL OR (wait_reason = 'budget_exhausted' AND status = 'failed') OR (wait_reason <> 'budget_exhausted' AND status = 'pending')`),
	check("ck_source_item_annotations_topic_candidates", sql`jsonb_typeof(topic_candidates_json) = 'array'`),
	check("ck_source_item_annotations_stance_polarity", sql`stance_polarity IS NULL OR stance_polarity IN ('supports','opposes','mixed','neutral')`),
	check("ck_source_item_annotations_stance_confidence", sql`stance_confidence IS NULL OR stance_confidence BETWEEN 0 AND 100`),
	check("ck_source_item_annotations_stance_shape", sql`stance_polarity IS NULL OR ((stance_polarity IN ('supports','opposes') AND stance_target IS NOT NULL AND stance_target_key IS NOT NULL) OR (stance_polarity IN ('mixed','neutral') AND stance_target_key IS NULL))`),
	// A succeeded annotation must carry the fields the digest pipeline reads;
	// Do not accept a partial result. It would look usable and then rank
	// against a NULL domain.
	check("ck_source_item_annotations_succeeded_complete", sql`status <> 'succeeded' OR (domain_key IS NOT NULL AND depth IS NOT NULL AND genre IS NOT NULL AND stance_polarity IS NOT NULL AND stance_confidence IS NOT NULL)`),
]);
