import { pgTable, index, unique, check, foreignKey, varchar, boolean, integer, doublePrecision, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces.js";
import { users } from "./auth.js";

/**
 * A reader's interest profile.
 *
 * Per user and owner-private: it is a model of one person, and in a shared
 * space no other member may read it. The row itself is deliberately thin — it
 * exists to anchor topics and candidates and to carry settings, not to cache
 * anything derivable.
 *
 * There is no stored coverage distribution. Coverage is computed from
 * annotations joined to this user's read state, so it cannot drift out of step
 * with the events it summarizes; a cached copy would need invalidating on every
 * read, every annotation, and every backfill, and the failure mode of a stale
 * one is a serendipity quota aimed at gaps that closed months ago.
 */
export const interestProfiles = pgTable("interest_profiles", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	/**
	 * Per-profile threshold overrides (new-topic threshold, decay half-life).
	 * Sparse: absent keys fall back to the code defaults.
	 */
	settingsJson: jsonb("settings_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	unique("uq_interest_profiles_space_user").on(t.spaceId, t.userId),
	unique("uq_interest_profiles_id_space").on(t.id, t.spaceId),
	foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "interest_profiles_space_fkey" }),
	foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "interest_profiles_user_fkey" }).onDelete("cascade"),
	check("ck_interest_profiles_settings", sql`jsonb_typeof(settings_json) = 'object'`),
]);

/**
 * A named topic in a reader's profile — the fine-grained axis.
 *
 * Distinct from the domain skeleton, which is coarse, code-owned, and about the
 * world. Topics are user data that grow from what this person actually reads,
 * and each maps onto one skeleton domain so "which cells are occupied" stays a
 * join rather than a second classification.
 *
 * `origin` records who put it here. It matters because the semantic layer is
 * confirmation-gated: an agent may propose a topic, but the row only exists
 * once the owner accepted it, and a topic the owner typed themselves must never
 * be silently rewritten by a later proposal.
 */
export const interestTopics = pgTable("interest_topics", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	profileId: varchar("profile_id", { length: 36 }).notNull(),
	/** Normalized match key. Stable; the label is what the owner may rename. */
	topicKey: varchar("topic_key", { length: 128 }).notNull(),
	label: varchar({ length: 128 }).notNull(),
	domainKey: varchar("domain_key", { length: 64 }).notNull(),
	/**
	 * Normalized phrases that also resolve to this topic.
	 *
	 * Annotation returns whatever phrase the model chose, and "LLM", "large
	 * language model", and "large language models" are the same interest.
	 * Without aliases each spelling becomes its own topic and the distribution
	 * shatters into synonyms — which then reads as coverage breadth the reader
	 * does not have.
	 */
	aliasesJson: jsonb("aliases_json").default([]).notNull(),
	weight: doublePrecision().default(1).notNull(),
	origin: varchar({ length: 16 }).default('user').notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	unique("uq_interest_topics_profile_key").on(t.profileId, t.topicKey),
	unique("uq_interest_topics_id_space").on(t.id, t.spaceId),
	index("ix_interest_topics_profile_status").on(t.profileId, t.status),
	index("ix_interest_topics_domain").on(t.spaceId, t.userId, t.domainKey),
	foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "interest_topics_space_fkey" }),
	foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "interest_topics_user_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.profileId, t.spaceId], foreignColumns: [interestProfiles.id, interestProfiles.spaceId], name: "interest_topics_profile_fkey" }).onDelete("cascade"),
	check("ck_interest_topics_origin", sql`origin IN ('user','agent')`),
	check("ck_interest_topics_status", sql`status IN ('active','archived')`),
	check("ck_interest_topics_weight", sql`weight >= 0`),
	check("ck_interest_topics_aliases", sql`jsonb_typeof(aliases_json) = 'array'`),
]);

/**
 * An observed topic phrase that does not yet resolve to any topic.
 *
 * This is the controlled part of controlled growth. Phrases accumulate with a
 * count instead of immediately becoming topics, so one stray annotation does
 * not create a topic the reader never cared about, and a phrase that keeps
 * recurring becomes visible as a real gap in their axis.
 *
 * `status` is terminal for `dismissed`: a phrase the owner rejected must stop
 * coming back every time the model says it again, which it otherwise would,
 * forever.
 */
export const interestTopicCandidates = pgTable("interest_topic_candidates", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	profileId: varchar("profile_id", { length: 36 }).notNull(),
	phraseKey: varchar("phrase_key", { length: 128 }).notNull(),
	displayPhrase: varchar("display_phrase", { length: 128 }).notNull(),
	/** Most frequent domain among the items this phrase appeared on. */
	domainKey: varchar("domain_key", { length: 64 }),
	occurrenceCount: integer("occurrence_count").default(0).notNull(),
	readCount: integer("read_count").default(0).notNull(),
	status: varchar({ length: 16 }).default('accumulating').notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	unique("uq_interest_topic_candidates_profile_phrase").on(t.profileId, t.phraseKey),
	index("ix_interest_topic_candidates_ready").on(t.profileId, t.status, t.occurrenceCount),
	foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "interest_topic_candidates_space_fkey" }),
	foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "interest_topic_candidates_user_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.profileId, t.spaceId], foreignColumns: [interestProfiles.id, interestProfiles.spaceId], name: "interest_topic_candidates_profile_fkey" }).onDelete("cascade"),
	check("ck_interest_topic_candidates_status", sql`status IN ('accumulating','ready','dismissed')`),
	check("ck_interest_topic_candidates_counts", sql`occurrence_count >= 0 AND read_count >= 0`),
]);

/**
 * Where a phrase seen on an item was accounted for.
 *
 * Without it, re-running the fact layer over material it already processed
 * would double-count every phrase, and the new-topic threshold would fire off
 * arithmetic rather than off the reader's behaviour. Keyed by item so the pass
 * is idempotent and can be re-run over any window safely.
 *
 * `counted_as_read` is what makes the ledger survive the ordering of real life.
 * Annotation happens when material arrives; reading happens later, often days
 * later. A ledger that only recorded "seen" would freeze every item at the
 * unread state it had when the pass first ran, and the read threshold — the
 * whole thing separating an interest from a source that publishes a lot — would
 * essentially never be met. Instead an item is revisited exactly once more,
 * when it first becomes read.
 */
export const interestTopicObservations = pgTable("interest_topic_observations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	profileId: varchar("profile_id", { length: 36 }).notNull(),
	sourceItemId: varchar("source_item_id", { length: 36 }).notNull(),
	countedAsRead: boolean("counted_as_read").default(false).notNull(),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
	unique("uq_interest_topic_observations_profile_item").on(t.profileId, t.sourceItemId),
	index("ix_interest_topic_observations_profile").on(t.profileId, t.observedAt),
	index("ix_interest_topic_observations_unread").on(t.profileId, t.countedAsRead),
	foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "interest_topic_observations_space_fkey" }),
	foreignKey({ columns: [t.profileId, t.spaceId], foreignColumns: [interestProfiles.id, interestProfiles.spaceId], name: "interest_topic_observations_profile_fkey" }).onDelete("cascade"),
]);
