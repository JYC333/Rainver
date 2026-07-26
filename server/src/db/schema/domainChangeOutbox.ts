import { pgTable, index, unique, check, foreignKey, varchar, text, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces";

// Transport/audit infrastructure only (see PROJECTS.md's source-reference
// and change-event contract"): it does not own domain state or generic
// cross-domain relationships. A source domain (Note, Inquiry, Experiment)
// writes one row here, in the SAME transaction as the new eligible revision
// it describes, carrying the exact discriminated immutable source reference
// a Knowledge promotion Candidate would pin to. Consumers (the
// revalidation worker) claim rows with a renewable lease and records failures
// for retry. The outbox is swept directly by the scheduler; it is not a
// second copy of domain state.
export const domainChangeOutbox = pgTable("domain_change_outbox", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceKind: varchar("source_kind", { length: 32 }).notNull(),
	sourceId: varchar("source_id", { length: 36 }).notNull(),
	// The exact discriminated pinned reference (note_revision |
	// inquiry_thread_revision) — see modules/knowledgePromotion/outbox.ts's
	// SourceRevisionRef for the shared shape.
	sourceRefJson: jsonb("source_ref_json").notNull(),
	changeKind: varchar("change_kind", { length: 48 }).notNull(),
	// Non-LLM staleness signal carried straight from the source event, so the
	// revalidation worker never has to re-derive it. Null only where the
	// source domain has no such signal.
	changeSignificance: varchar("change_significance", { length: 16 }),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }),
	claimToken: varchar("claim_token", { length: 36 }),
	claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true, mode: 'string' }),
	attemptCount: integer("attempt_count").default(0).notNull(),
	lastError: text("last_error"),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_domain_change_outbox_pending").using("btree", table.spaceId.asc().nullsLast(), table.claimExpiresAt.asc().nullsLast(), table.occurredAt.asc().nullsLast()).where(sql`processed_at IS NULL`),
	index("ix_domain_change_outbox_source").using("btree", table.spaceId.asc().nullsLast(), table.sourceKind.asc().nullsLast(), table.sourceId.asc().nullsLast()),
	unique("uq_domain_change_outbox_id_space_id").on(table.id, table.spaceId),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "domain_change_outbox_space_id_fkey" }),
	check("ck_domain_change_outbox_source_kind", sql`(source_kind)::text = ANY (ARRAY[('note'::character varying)::text, ('inquiry_thread'::character varying)::text, ('experiment_interpretation'::character varying)::text])`),
	check("ck_domain_change_outbox_significance", sql`change_significance IS NULL OR (change_significance)::text = ANY (ARRAY[('trivial'::character varying)::text, ('material'::character varying)::text])`),
]);
