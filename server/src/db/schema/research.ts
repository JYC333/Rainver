import { check, doublePrecision, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, varchar, integer, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { projects } from "./projects";
import { projectOperations } from "./projectOperations";
import { projectResearchContextVersions } from "./projectResearchContext";
import { researchScanSummaries } from "./projectResearch";
import { proposals } from "./proposals";

export const researchQueryStrategies = pgTable("research_query_strategies", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(),
  operationId: varchar("operation_id", { length: 36 }),
  researchContextVersionId: varchar("research_context_version_id", { length: 36 }).notNull(),
  createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
  questionSnapshot: text("question_snapshot").notNull(),
  status: varchar({ length: 16 }).notNull(),
  policyVersion: varchar("policy_version", { length: 64 }).notNull(),
  policyJson: jsonb("policy_json").default({}).notNull(),
  executionBudgetJson: jsonb("execution_budget_json").default({}).notNull(),
  version: integer().notNull(),
  parentStrategyId: varchar("parent_strategy_id", { length: 36 }),
  adaptationDirection: varchar("adaptation_direction", { length: 16 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  selectedAt: timestamp("selected_at", { withTimezone: true, mode: "string" }),
  materializedAt: timestamp("materialized_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_research_query_strategies_project_created").on(table.spaceId, table.projectId, table.createdAt),
  index("ix_research_query_strategies_operation").on(table.operationId),
  unique("uq_research_query_strategies_id_space").on(table.id, table.spaceId),
  uniqueIndex("uq_research_query_strategies_context_version").on(table.spaceId, table.projectId, table.researchContextVersionId, table.version),
  foreignKey({
    columns: [table.projectId, table.spaceId],
    foreignColumns: [projects.id, projects.spaceId],
    name: "research_query_strategies_project_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.researchContextVersionId, table.projectId, table.spaceId],
    foreignColumns: [projectResearchContextVersions.id, projectResearchContextVersions.projectId, projectResearchContextVersions.spaceId],
    name: "research_query_strategies_context_fkey",
  }),
  foreignKey({
    columns: [table.operationId],
    foreignColumns: [projectOperations.id],
    name: "research_query_strategies_operation_delete_fkey",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.operationId, table.projectId, table.spaceId],
    foreignColumns: [projectOperations.id, projectOperations.projectId, projectOperations.spaceId],
    name: "research_query_strategies_operation_fkey",
  }),
  foreignKey({
    columns: [table.createdByUserId],
    foreignColumns: [users.id],
    name: "research_query_strategies_user_fkey",
  }),
  foreignKey({
    columns: [table.parentStrategyId, table.spaceId],
    foreignColumns: [table.id, table.spaceId],
    name: "research_query_strategies_parent_fkey",
  }),
  check("ck_research_query_strategies_status", sql`status IN ('planning','evaluating','selected','materialized','failed')`),
  check("ck_research_query_strategies_question", sql`char_length(question_snapshot) BETWEEN 1 AND 2000`),
  check("ck_research_query_strategies_json", sql`jsonb_typeof(policy_json)='object' AND jsonb_typeof(execution_budget_json)='object'`),
  check("ck_research_query_strategies_version", sql`version >= 1`),
  check("ck_research_query_strategies_adaptation", sql`adaptation_direction IS NULL OR adaptation_direction IN ('broaden','narrow','rollback')`),
]);

export const researchQueryProviderPlans = pgTable("research_query_provider_plans", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  strategyId: varchar("strategy_id", { length: 36 }).notNull(),
  providerKey: varchar("provider_key", { length: 32 }).notNull(),
  status: varchar({ length: 16 }).notNull(),
  terminalDecision: varchar("terminal_decision", { length: 16 }),
  decisionReason: text("decision_reason"),
  coverageWarning: text("coverage_warning"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  uniqueIndex("uq_research_query_provider_plans_strategy_provider").on(table.strategyId, table.providerKey),
  unique("uq_research_query_provider_plans_id_space").on(table.id, table.spaceId),
  foreignKey({
    columns: [table.strategyId, table.spaceId],
    foreignColumns: [researchQueryStrategies.id, researchQueryStrategies.spaceId],
    name: "research_query_provider_plans_strategy_fkey",
  }).onDelete("cascade"),
  check("ck_research_query_provider_plans_provider", sql`provider_key IN ('arxiv','openalex','semantic_scholar','web_search')`),
  check("ck_research_query_provider_plans_status", sql`status IN ('pending','evaluating','selected','unavailable','failed')`),
  check("ck_research_query_provider_plans_decision", sql`terminal_decision IS NULL OR terminal_decision IN ('accept','broaden','narrow','stop')`),
]);

export const researchQueryAttempts = pgTable("research_query_attempts", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  providerPlanId: varchar("provider_plan_id", { length: 36 }).notNull(),
  round: integer().default(0).notNull(),
  sequence: integer().notNull(),
  direction: varchar({ length: 16 }).notNull(),
  semanticQueryJson: jsonb("semantic_query_json").notNull(),
  compiledQueryJson: jsonb("compiled_query_json").notNull(),
  queryFingerprint: varchar("query_fingerprint", { length: 128 }).notNull(),
  providerHitCount: integer("provider_hit_count"),
  accessibleHitCount: integer("accessible_hit_count"),
  sampleSummaryJson: jsonb("sample_summary_json"),
  relevanceMetricsJson: jsonb("relevance_metrics_json"),
  score: doublePrecision(),
  decision: varchar({ length: 16 }),
  decisionReason: text("decision_reason"),
  errorClass: varchar("error_class", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  uniqueIndex("uq_research_query_attempts_plan_round_sequence").on(table.providerPlanId, table.round, table.sequence),
  unique("uq_research_query_attempts_id_space").on(table.id, table.spaceId),
  unique("uq_research_query_attempts_id_plan_space").on(table.id, table.providerPlanId, table.spaceId),
  index("ix_research_query_attempts_fingerprint").on(table.spaceId, table.queryFingerprint),
  foreignKey({
    columns: [table.providerPlanId, table.spaceId],
    foreignColumns: [researchQueryProviderPlans.id, researchQueryProviderPlans.spaceId],
    name: "research_query_attempts_plan_fkey",
  }).onDelete("cascade"),
  check("ck_research_query_attempts_round", sql`round >= 0`),
  check("ck_research_query_attempts_sequence", sql`sequence BETWEEN 1 AND 4`),
  check("ck_research_query_attempts_direction", sql`direction IN ('initial','broaden','narrow')`),
  check("ck_research_query_attempts_decision", sql`decision IS NULL OR decision IN ('accept','broaden','narrow','stop')`),
  check("ck_research_query_attempts_counts", sql`(provider_hit_count IS NULL OR provider_hit_count >= 0) AND (accessible_hit_count IS NULL OR accessible_hit_count >= 0)`),
  check("ck_research_query_attempts_json", sql`jsonb_typeof(semantic_query_json)='object' AND jsonb_typeof(compiled_query_json)='object' AND (sample_summary_json IS NULL OR jsonb_typeof(sample_summary_json)='object') AND (relevance_metrics_json IS NULL OR jsonb_typeof(relevance_metrics_json)='object')`),
]);

export const researchQueryProviderSelections = pgTable("research_query_provider_selections", {
  providerPlanId: varchar("provider_plan_id", { length: 36 }).primaryKey().notNull(),
  attemptId: varchar("attempt_id", { length: 36 }).notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  selectedAt: timestamp("selected_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_research_query_provider_selections_attempt").on(table.attemptId),
  foreignKey({
    columns: [table.providerPlanId, table.spaceId],
    foreignColumns: [researchQueryProviderPlans.id, researchQueryProviderPlans.spaceId],
    name: "research_query_provider_selections_plan_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.attemptId, table.providerPlanId, table.spaceId],
    foreignColumns: [researchQueryAttempts.id, researchQueryAttempts.providerPlanId, researchQueryAttempts.spaceId],
    name: "research_query_provider_selections_attempt_fkey",
  }).onDelete("cascade"),
]);

/** Immutable rolling observations used to decide whether monitoring vocabulary
 * has drifted enough to justify evaluating a replacement query version. */
export const researchQueryPerformanceObservations = pgTable("research_query_performance_observations", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  strategyId: varchar("strategy_id", { length: 36 }).notNull(),
  scanSummaryId: varchar("scan_summary_id", { length: 36 }).notNull(),
  newCandidateCount: integer("new_candidate_count").notNull(),
  screenedCount: integer("screened_count").notNull(),
  acceptedCount: integer("accepted_count").notNull(),
  duplicateRate: doublePrecision("duplicate_rate").notNull(),
  queueLatencyMs: integer("queue_latency_ms"),
  coreConceptCoverage: doublePrecision("core_concept_coverage"),
  observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  uniqueIndex("uq_research_query_performance_scan_strategy").on(table.scanSummaryId, table.strategyId),
  index("ix_research_query_performance_strategy_observed").on(table.spaceId, table.strategyId, table.observedAt),
  foreignKey({
    columns: [table.strategyId, table.spaceId],
    foreignColumns: [researchQueryStrategies.id, researchQueryStrategies.spaceId],
    name: "research_query_performance_strategy_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.scanSummaryId, table.spaceId],
    foreignColumns: [researchScanSummaries.id, researchScanSummaries.spaceId],
    name: "research_query_performance_scan_fkey",
  }).onDelete("cascade"),
  check("ck_research_query_performance_counts", sql`new_candidate_count >= 0 AND screened_count >= 0 AND accepted_count >= 0 AND accepted_count <= screened_count`),
  check("ck_research_query_performance_rates", sql`duplicate_rate BETWEEN 0 AND 1 AND (core_concept_coverage IS NULL OR core_concept_coverage BETWEEN 0 AND 1)`),
  check("ck_research_query_performance_latency", sql`queue_latency_ms IS NULL OR queue_latency_ms >= 0`),
]);

/** Append-only activation history. Exactly one row per research context may be
 * active; switching versions closes the old row and inserts a new one. */
export const researchQueryStrategyActivations = pgTable("research_query_strategy_activations", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(),
  researchContextVersionId: varchar("research_context_version_id", { length: 36 }).notNull(),
  strategyId: varchar("strategy_id", { length: 36 }).notNull(),
  previousStrategyId: varchar("previous_strategy_id", { length: 36 }),
  sequence: integer().notNull(),
  reason: varchar({ length: 32 }).notNull(),
  proposalId: varchar("proposal_id", { length: 36 }),
  activatedByUserId: varchar("activated_by_user_id", { length: 36 }).notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true, mode: "string" }).notNull(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  uniqueIndex("uq_research_query_activation_sequence").on(table.spaceId, table.projectId, table.researchContextVersionId, table.sequence),
  uniqueIndex("uq_research_query_activation_active").on(table.spaceId, table.projectId, table.researchContextVersionId).where(sql`deactivated_at IS NULL`),
  index("ix_research_query_activation_strategy").on(table.spaceId, table.strategyId),
  foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "research_query_activation_project_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.researchContextVersionId, table.projectId, table.spaceId], foreignColumns: [projectResearchContextVersions.id, projectResearchContextVersions.projectId, projectResearchContextVersions.spaceId], name: "research_query_activation_context_fkey" }),
  foreignKey({ columns: [table.strategyId, table.spaceId], foreignColumns: [researchQueryStrategies.id, researchQueryStrategies.spaceId], name: "research_query_activation_strategy_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.previousStrategyId, table.spaceId], foreignColumns: [researchQueryStrategies.id, researchQueryStrategies.spaceId], name: "research_query_activation_previous_fkey" }),
  foreignKey({ columns: [table.proposalId, table.spaceId], foreignColumns: [proposals.id, proposals.spaceId], name: "research_query_activation_proposal_fkey" }),
  foreignKey({ columns: [table.activatedByUserId], foreignColumns: [users.id], name: "research_query_activation_user_fkey" }),
  check("ck_research_query_activation_sequence", sql`sequence >= 1`),
  check("ck_research_query_activation_reason", sql`reason IN ('initial','monitoring_feedback','rollback','manual')`),
]);
