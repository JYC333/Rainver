import { boolean, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, varchar, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { importedSessions } from "./importedSessions.js";
import { spaces } from "./spaces.js";
import { users } from "./auth.js";

/**
 * What an imported CLI session says, short enough to carry.
 *
 * Named for the module's own language — imported *history* — deliberately
 * avoiding the retired Runtime Context table name the absence check keeps out
 * of the tree. Reusing that name would send anyone grepping for the retired
 * concept to this table instead.
 *
 * A session runs to thousands of records, so referencing one whole is only
 * possible as a summary — the same reason a Room conversation has one. It is
 * *not* the Room's summary machinery: that service compacts a growing message
 * thread incrementally, carrying a covered-through message and a supersession
 * chain. An imported session has neither. Its records are fixed until the
 * folder is re-synced, so one row per session is enough, regenerated when
 * `last_record_at` moves past `covered_through_record_at`.
 *
 * Owner-funded, like extraction: the person whose machine it came from pays
 * for reading their own history.
 */
export const importedHistorySummaries = pgTable("imported_history_summaries", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  importedSessionId: varchar("imported_session_id", { length: 36 }).notNull(),
  summaryText: text("summary_text").notNull(),
  /** The session's `last_record_at` when this was written; the staleness test. */
  coveredThroughRecordAt: timestamp("covered_through_record_at", { withTimezone: true, mode: "string" }),
  coveredRecordCount: integer("covered_record_count").notNull(),
  /**
   * The summarizer did not see the whole session — the record or character
   * budget bit. Persisted because the row is otherwise indistinguishable from
   * one that covered everything, and a reader deciding whether to trust
   * "where it was left" needs to know the beginning was dropped.
   */
  sourceTruncated: boolean("source_truncated").notNull().default(false),
  sourceTokenEstimate: integer("source_token_estimate").notNull(),
  summaryTokenEstimate: integer("summary_token_estimate").notNull(),
  ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
  providerId: varchar("provider_id", { length: 36 }),
  model: varchar({ length: 128 }),
  usageJson: jsonb("usage_json"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_imported_history_summaries_session").on(table.importedSessionId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "imported_history_summaries_space_fkey" }).onDelete("cascade"),
  // By id alone, as `imported_session_records` does: `imported_sessions` has
  // no unique on `(id, space_id)` for a composite key to match.
  foreignKey({ columns: [table.importedSessionId], foreignColumns: [importedSessions.id], name: "imported_history_summaries_session_fkey" }).onDelete("cascade"),
  // `cascade`, as `imported_sessions.owner_user_id` is. This table is a
  // derived cache, not a record worth preserving past its subject; a
  // non-deferrable RESTRICT here could block a user delete before the session
  // cascade removed the row anyway.
  foreignKey({ columns: [table.ownerUserId], foreignColumns: [users.id], name: "imported_history_summaries_owner_fkey" }).onDelete("cascade"),
]);
