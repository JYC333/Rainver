import {
  pgTable,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
  varchar,
  integer,
  jsonb,
  text,
  timestamp,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { projects } from "./projects.js";
import { sourceItems } from "./sources.js";
import { spaces } from "./spaces.js";
import { informationDigests } from "./informationDigests.js";

/**
 * One generation of a scope's briefing: a version. Its inputs are frozen in
 * `information_briefing_inputs`; its result is the validated model output.
 * A ready version is never rewritten — a changed input set is a new version.
 * Attempts of one version share this row; `run_id` names the current attempt,
 * and only that Run's terminal projection may settle it.
 */
export const informationBriefings = pgTable("information_briefings", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  scopeType: varchar("scope_type", { length: 16 }).notNull(),
  projectId: varchar("project_id", { length: 36 }),
  ownerUserId: varchar("owner_user_id", { length: 36 }),
  /** `project:<id>` or `personal:<user>`: one key for uniqueness and locking. */
  scopeKey: varchar("scope_key", { length: 64 }).notNull(),
  kind: varchar({ length: 16 }).notNull(),
  version: integer().notNull(),
  /** The sealed day a `daily`/`backfill` briefing belongs to. */
  periodDate: varchar("period_date", { length: 10 }),
  digestId: varchar("digest_id", { length: 36 }),
  cutoffAt: timestamp("cutoff_at", { withTimezone: true, mode: "string" }).notNull(),
  /** Window start this version compared from: the previous version's cutoff, or the baseline window. */
  sinceAt: timestamp("since_at", { withTimezone: true, mode: "string" }),
  comparison: varchar({ length: 16 }).notNull(),
  previousBriefingId: varchar("previous_briefing_id", { length: 36 }),
  protocolVersion: varchar("protocol_version", { length: 64 }).notNull(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  contextHash: varchar("context_hash", { length: 64 }).notNull(),
  /** Scope, kind, input/context hashes, protocol and execution selection: the same request reuses this version. */
  requestKey: varchar("request_key", { length: 64 }).notNull(),
  /** SHA-256 of the exact prompt + instruction this version froze; every attempt sends exactly that request. */
  requestHash: varchar("request_hash", { length: 64 }),
  status: varchar({ length: 16 }).notNull(),
  outcome: varchar({ length: 24 }),
  attempt: integer().default(0).notNull(),
  runId: varchar("run_id", { length: 36 }),
  requestedByUserId: varchar("requested_by_user_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 36 }),
  runtimeProfileId: varchar("runtime_profile_id", { length: 36 }),
  contextJson: jsonb("context_json").default([]).notNull(),
  /**
   * Previous highlights sent as comparison, each with the full dependency
   * closure of the text it carries (material, analysis, signals and context of
   * the version it came from, transitively); the whole version depends on them.
   */
  comparisonJson: jsonb("comparison_json").default([]).notNull(),
  /** A reserved sealed day's deferred request (origin, Automation, execution, label), replayed in date order. */
  requestJson: jsonb("request_json"),
  coverageJson: jsonb("coverage_json").default({}).notNull(),
  resultJson: jsonb("result_json"),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  /** Bookkeeping only: when a request last found this version still current. Never an input. */
  checkedAt: timestamp("checked_at", { withTimezone: true, mode: "string" }),
}, (t): PgTableExtraConfigValue[] => [
  unique("uq_information_briefings_id_space").on(t.id, t.spaceId),
  uniqueIndex("uq_information_briefings_version").on(t.spaceId, t.scopeKey, t.version),
  uniqueIndex("uq_information_briefings_request").on(t.spaceId, t.scopeKey, t.requestKey),
  /** One live version per sealed day; a failed or cancelled day stays as history beside its replacement. */
  uniqueIndex("uq_information_briefings_day").on(t.spaceId, t.scopeKey, t.periodDate)
    .where(sql`kind IN ('daily','backfill') AND status IN ('queued','ready','blocked')`),
  /** At most one version of a scope is being generated at a time. */
  uniqueIndex("uq_information_briefings_in_flight").on(t.spaceId, t.scopeKey).where(sql`status = 'queued'`),
  uniqueIndex("uq_information_briefings_run").on(t.runId).where(sql`run_id IS NOT NULL`),
  index("ix_information_briefings_scope_recent").on(t.spaceId, t.scopeKey, t.cutoffAt),
  foreignKey({ columns: [t.spaceId], foreignColumns: [spaces.id], name: "information_briefings_space_fkey" }),
  foreignKey({ columns: [t.projectId, t.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "information_briefings_project_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerUserId], foreignColumns: [users.id], name: "information_briefings_owner_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.requestedByUserId], foreignColumns: [users.id], name: "information_briefings_requester_fkey" }),
  // NO ACTION: a sealed digest a briefing day was built from is not deleted on its own (SET NULL would
  // null the tenant column too); deleting the Project removes both together through their cascades.
  foreignKey({ columns: [t.digestId, t.spaceId], foreignColumns: [informationDigests.id, informationDigests.spaceId], name: "information_briefings_digest_fkey" }),
  check("ck_information_briefings_scope", sql`(scope_type = 'project' AND project_id IS NOT NULL AND owner_user_id IS NULL) OR (scope_type = 'personal' AND owner_user_id IS NOT NULL AND project_id IS NULL)`),
  check("ck_information_briefings_kind", sql`kind IN ('manual','daily','backfill')`),
  check("ck_information_briefings_day", sql`(kind = 'manual') = (period_date IS NULL)`),
  check("ck_information_briefings_status", sql`status IN ('queued','ready','failed','blocked','cancelled')`),
  check("ck_information_briefings_outcome", sql`outcome IS NULL OR outcome IN ('briefing','no_new_material','no_material')`),
  check("ck_information_briefings_ready", sql`(status = 'ready') = (outcome IS NOT NULL)`),
  check("ck_information_briefings_comparison", sql`comparison IN ('baseline','delta')`),
  check("ck_information_briefings_version", sql`version > 0 AND attempt >= 0`),
]);

/**
 * A frozen reference of one briefing: a Source item (with the content
 * revision and analysis references it was judged on) or a context entry.
 * `analysis_json.deps` lists every dependency whose text reached the model
 * (each contributing item, annotation and scope signal, with its revision and
 * Source connection); dispatch, publication and reads re-check exactly these.
 * No body text is copied here.
 */
export const informationBriefingInputs = pgTable("information_briefing_inputs", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  briefingId: varchar("briefing_id", { length: 36 }).notNull(),
  /** `S<n>` for material, `C<n>` for context: the key the model cites. */
  refKey: varchar("ref_key", { length: 8 }),
  refKind: varchar("ref_kind", { length: 16 }).notNull(),
  sourceItemId: varchar("source_item_id", { length: 36 }),
  familyKey: varchar("family_key", { length: 128 }),
  contentRevision: varchar("content_revision", { length: 128 }),
  /** `included`, or why it was left out of the model input this time. */
  status: varchar({ length: 24 }).notNull(),
  deltaClass: varchar("delta_class", { length: 24 }),
  analysisJson: jsonb("analysis_json").default({}).notNull(),
  activityAt: timestamp("activity_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex("uq_information_briefing_inputs_ref").on(t.briefingId, t.refKey).where(sql`ref_key IS NOT NULL`),
  index("ix_information_briefing_inputs_briefing").on(t.briefingId, t.refKind, t.status),
  index("ix_information_briefing_inputs_item").on(t.spaceId, t.sourceItemId),
  foreignKey({ columns: [t.briefingId, t.spaceId], foreignColumns: [informationBriefings.id, informationBriefings.spaceId], name: "information_briefing_inputs_briefing_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.sourceItemId, t.spaceId], foreignColumns: [sourceItems.id, sourceItems.spaceId], name: "information_briefing_inputs_item_fkey" }).onDelete("cascade"),
  check("ck_information_briefing_inputs_kind", sql`ref_kind IN ('source_item','context')`),
  check("ck_information_briefing_inputs_item", sql`(ref_kind = 'source_item') = (source_item_id IS NOT NULL)`),
  check("ck_information_briefing_inputs_status", sql`status IN ('included','not_ready','truncated','egress_refused','not_shared')`),
  check("ck_information_briefing_inputs_delta", sql`delta_class IS NULL OR delta_class IN ('baseline','new_publication','newly_found','revised','evidenced_change','unknown_time','background')`),
]);
