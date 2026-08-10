import { pgTable, index, unique, check, foreignKey, varchar, text, integer, doublePrecision, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { spaces } from "./spaces";

export const cards = pgTable("cards", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	cardType: varchar("card_type", { length: 32 }).notNull(),
	front: text().notNull(),
	back: text().notNull(),
	sourceType: varchar("source_type", { length: 32 }),
	sourceId: varchar("source_id", { length: 36 }),
	status: varchar({ length: 32 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	metadataJson: jsonb("metadata_json"),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_cards_card_type").using("btree", table.cardType.asc().nullsLast()),
	index("ix_cards_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("ix_cards_source").using("btree", table.sourceType.asc().nullsLast(), table.sourceId.asc().nullsLast()),
	index("ix_cards_source_id").using("btree", table.sourceId.asc().nullsLast()),
	index("ix_cards_source_type").using("btree", table.sourceType.asc().nullsLast()),
	index("ix_cards_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_cards_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "cards_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "cards_space_id_fkey"
		}),
	check("ck_cards_card_type", sql`(card_type)::text = ANY (ARRAY[('basic'::character varying)::text, ('cloze'::character varying)::text])`),
	// B12G: membership is declared by the `CardSourceable` interface in
	// `modules/ontology/entities.ts`.
	check("ck_cards_source_type_format", sql`(source_type IS NULL) OR ((source_type)::text ~ '^[a-z][a-z0-9_]{0,63}$'::text)`),
	check("ck_cards_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('suspended'::character varying)::text, ('archived'::character varying)::text])`),
]);

export const cardReviewStates = pgTable("card_review_states", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	cardId: varchar("card_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	stability: doublePrecision(),
	difficulty: doublePrecision(),
	elapsedDays: doublePrecision("elapsed_days"),
	scheduledDays: doublePrecision("scheduled_days"),
	reps: integer().notNull(),
	lapses: integer().notNull(),
	state: varchar({ length: 32 }),
	lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_card_review_states_card_id").using("btree", table.cardId.asc().nullsLast()),
	index("ix_card_review_states_user_due").using("btree", table.userId.asc().nullsLast(), table.dueAt.asc().nullsLast()),
	foreignKey({
			columns: [table.cardId],
			foreignColumns: [cards.id],
			name: "card_review_states_card_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "card_review_states_user_id_fkey"
		}),
	unique("uq_card_review_states_card_user").on(table.cardId, table.userId),
	check("ck_card_review_states_state", sql`(state IS NULL) OR ((state)::text = ANY (ARRAY[('new'::character varying)::text, ('learning'::character varying)::text, ('review'::character varying)::text, ('relearning'::character varying)::text]))`),
]);

export const cardReviews = pgTable("card_reviews", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	cardId: varchar("card_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	rating: varchar({ length: 16 }).notNull(),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }).notNull(),
	reviewStateSnapshotJson: jsonb("review_state_snapshot_json"),
	durationMs: integer("duration_ms"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_card_reviews_card_id").using("btree", table.cardId.asc().nullsLast()),
	index("ix_card_reviews_rating").using("btree", table.rating.asc().nullsLast()),
	index("ix_card_reviews_user_reviewed_at").using("btree", table.userId.asc().nullsLast(), table.reviewedAt.asc().nullsLast()),
	foreignKey({
			columns: [table.cardId],
			foreignColumns: [cards.id],
			name: "card_reviews_card_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "card_reviews_user_id_fkey"
		}),
	check("ck_card_reviews_rating", sql`(rating)::text = ANY (ARRAY[('again'::character varying)::text, ('hard'::character varying)::text, ('good'::character varying)::text, ('easy'::character varying)::text])`),
]);
