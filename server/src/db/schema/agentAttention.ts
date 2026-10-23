import { sql } from "drizzle-orm";
import { pgTable, varchar, timestamp, jsonb, boolean, integer, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";

/** Personal enablement time, independent of membership and immutable after creation. */
export const agentAttentionBaselines = pgTable("agent_attention_baselines", {
  userId: varchar("user_id", { length: 36 }).primaryKey().references(() => users.id, { onDelete: "cascade" }),
  enabledAt: timestamp("enabled_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const agentAttentionReadStates = pgTable("agent_attention_read_states", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  spaceId: varchar("space_id", { length: 36 }).notNull().references(() => spaces.id, { onDelete: "cascade" }),
  workKind: varchar("work_kind", { length: 32 }).notNull(),
  workSourceId: varchar("work_source_id", { length: 36 }).notNull(),
  readSubjectKind: varchar("read_subject_kind", { length: 32 }).notNull(),
  readSubjectId: varchar("read_subject_id", { length: 36 }).notNull(),
  lastReadRevisionJson: jsonb("last_read_revision_json"),
  readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
  manualUnread: boolean("manual_unread").default(false).notNull(),
  stateVersion: integer("state_version").default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("uq_agent_attention_read_subject").on(t.userId, t.spaceId, t.workKind, t.workSourceId, t.readSubjectKind, t.readSubjectId),
  index("ix_agent_attention_read_user_space").on(t.userId, t.spaceId),
  check("ck_agent_attention_work_kind", sql`work_kind IN ('task','session','agent_group','run')`),
  check("ck_agent_attention_subject_kind", sql`read_subject_kind IN ('message','run_result','authorization','run_decision','proposal','task','task_merge')`),
  check("ck_agent_attention_state_version", sql`state_version >= 0`),
  check("ck_agent_attention_revision", sql`last_read_revision_json IS NULL OR (jsonb_typeof(last_read_revision_json) = 'object' AND last_read_revision_json->>'schema_version' = '1' AND octet_length(last_read_revision_json::text) <= 2048)`),
]);
