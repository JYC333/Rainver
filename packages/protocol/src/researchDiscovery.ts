import { z } from "zod";

export const ResearchProviderKeySchema = z.enum([
  "arxiv",
  "openalex",
  "semantic_scholar",
  "web_search",
]);
export type ResearchProviderKey = z.infer<typeof ResearchProviderKeySchema>;

const BoundedCriterionSchema = z.string().trim().min(1).max(200);
const BoundedCriteriaSchema = z.array(BoundedCriterionSchema).max(10);

export const ResearchContextSchema = z.object({
  schema_version: z.literal("research_context.v1"),
  objective: z.string().trim().min(1).max(2_000),
  sub_questions: BoundedCriteriaSchema,
  in_scope: BoundedCriteriaSchema,
  out_of_scope: BoundedCriteriaSchema,
  must_have: BoundedCriteriaSchema,
  nice_to_have: BoundedCriteriaSchema,
  time_window: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
  }).strict().nullable(),
  source_scope: z.object({
    providers: z.array(ResearchProviderKeySchema).min(1).max(4),
    include_web: z.boolean(),
  }).strict(),
}).strict();
export type ResearchContext = z.infer<typeof ResearchContextSchema>;

export const ResearchContextVersionSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  version: z.number().int().min(1),
  context: ResearchContextSchema,
  assessment: z.record(z.unknown()),
  provenance: z.record(z.unknown()),
  created_at: z.string(),
}).strict();
export type ResearchContextVersion = z.infer<typeof ResearchContextVersionSchema>;

export const ResearchSemanticConceptSchema = z.object({
  value: z.string().trim().min(1).max(80),
  synonyms: z.array(z.string().trim().min(1).max(80)).max(6),
  weight: z.number().min(0).max(1),
}).strict();
export type ResearchSemanticConcept = z.infer<typeof ResearchSemanticConceptSchema>;

export const ResearchSemanticQuerySchema = z.object({
  schema_version: z.literal("research_semantic_query.v1"),
  core: z.array(ResearchSemanticConceptSchema).min(1).max(4),
  expansions: z.array(ResearchSemanticConceptSchema).max(8),
  qualifiers: z.array(ResearchSemanticConceptSchema).max(8),
  exclusions: z.array(ResearchSemanticConceptSchema).max(8),
  time_window: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
  }).strict().nullable(),
}).strict();
export type ResearchSemanticQuery = z.infer<typeof ResearchSemanticQuerySchema>;

export const ResearchCompiledQuerySchema = z.object({
  schema_version: z.literal("research_compiled_query.v1"),
  provider_key: ResearchProviderKeySchema,
  query: z.record(z.unknown()),
  fingerprint: z.string().min(16).max(128),
}).strict();
export type ResearchCompiledQuery = z.infer<typeof ResearchCompiledQuerySchema>;

export const ResearchPreviewSampleSchema = z.object({
  sample_id: z.string().min(1).max(512),
  title: z.string().min(1).max(1_024),
  source_uri: z.string().nullable(),
  occurred_at: z.string().nullable(),
  excerpt: z.string().max(2_048).nullable(),
  relevance: z.enum(["relevant", "maybe", "not_relevant"]),
  matched_core_concepts: z.array(z.string().max(80)).max(4),
}).strict();
export type ResearchPreviewSample = z.infer<typeof ResearchPreviewSampleSchema>;

export const ResearchPreviewObservationSchema = z.object({
  schema_version: z.literal("research_preview_observation.v1"),
  provider_hit_count: z.number().int().min(0),
  accessible_hit_count: z.number().int().min(0),
  samples: z.array(ResearchPreviewSampleSchema).max(20),
  relevance_rate: z.number().min(0).max(1),
  relevance_lower_bound: z.number().min(0).max(1),
  diversity_score: z.number().min(0).max(1),
  duplicate_rate: z.number().min(0).max(1),
}).strict();
export type ResearchPreviewObservation = z.infer<typeof ResearchPreviewObservationSchema>;

export const ResearchQueryAttemptDirectionSchema = z.enum(["initial", "broaden", "narrow"]);
export type ResearchQueryAttemptDirection = z.infer<typeof ResearchQueryAttemptDirectionSchema>;

export const ResearchQueryDecisionSchema = z.enum(["accept", "broaden", "narrow", "stop"]);
export type ResearchQueryDecision = z.infer<typeof ResearchQueryDecisionSchema>;

// Kept in sync with server/src/modules/research/queryPlanning/queryPolicy.ts's
// MAX_RESEARCH_QUERY_ATTEMPTS — the protocol package cannot import a server
// constant, so this bound (and the attempts array bound below) is duplicated.
export const ResearchQueryAttemptSchema = z.object({
  id: z.string().uuid(),
  provider_plan_id: z.string().uuid(),
  // round 0 is the original evaluation; round N is the Nth manual per-provider
  // retry. sequence resets to 1-4 within each round.
  round: z.number().int().min(0),
  sequence: z.number().int().min(1).max(4),
  direction: ResearchQueryAttemptDirectionSchema,
  semantic_query: ResearchSemanticQuerySchema,
  compiled_query: ResearchCompiledQuerySchema,
  observation: ResearchPreviewObservationSchema.nullable(),
  score: z.number().nullable(),
  decision: ResearchQueryDecisionSchema.nullable(),
  decision_reason: z.string().max(1_000).nullable(),
  error_class: z.string().max(64).nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
}).strict();
export type ResearchQueryAttempt = z.infer<typeof ResearchQueryAttemptSchema>;

export const ResearchQueryProviderPlanSchema = z.object({
  id: z.string().uuid(),
  provider_key: ResearchProviderKeySchema,
  status: z.enum(["pending", "evaluating", "selected", "unavailable", "failed"]),
  // Bounded at 4 attempts per round (see ResearchQueryAttemptSchema.round),
  // but a provider plan can accumulate attempts across many manual retries.
  attempts: z.array(ResearchQueryAttemptSchema).max(200),
  selected_attempt_id: z.string().uuid().nullable(),
  terminal_decision: ResearchQueryDecisionSchema.nullable(),
  decision_reason: z.string().max(1_000).nullable(),
  coverage_warning: z.string().max(1_000).nullable(),
}).strict();
export type ResearchQueryProviderPlan = z.infer<typeof ResearchQueryProviderPlanSchema>;

export const ResearchQueryStrategySchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  research_context_version_id: z.string().uuid(),
  question_snapshot: z.string().min(1).max(2_000),
  status: z.enum(["planning", "evaluating", "selected", "materialized", "failed"]),
  policy_version: z.string().min(1).max(64),
  policy: z.record(z.unknown()),
  execution_budget: z.record(z.unknown()),
  version: z.number().int().min(1),
  parent_strategy_id: z.string().uuid().nullable(),
  adaptation_direction: z.enum(["broaden", "narrow", "rollback"]).nullable(),
  provider_plans: z.array(ResearchQueryProviderPlanSchema).max(4),
  created_at: z.string(),
  selected_at: z.string().nullable(),
  materialized_at: z.string().nullable(),
}).strict();
export type ResearchQueryStrategy = z.infer<typeof ResearchQueryStrategySchema>;

export const ListResearchQueryStrategiesResponseSchema = z.object({
  active_strategy_ids: z.array(z.string().uuid()),
  strategies: z.array(ResearchQueryStrategySchema),
}).strict();
export type ListResearchQueryStrategiesResponse = z.infer<typeof ListResearchQueryStrategiesResponseSchema>;

export const EvaluateResearchQueryStrategyRequestSchema = z.object({
  project_id: z.string().uuid(),
  research_context_version_id: z.string().uuid(),
  providers: z.array(ResearchProviderKeySchema).min(1).max(4),
  candidate_budget: z.number().int().min(1).max(10_000),
  credentials: z.record(z.string().trim().min(1)).optional(),
  execution: z.object({
    model_provider_id: z.string().trim().min(1).optional(),
    model_name: z.string().trim().min(1).optional(),
  }).strict().optional(),
}).strict();
export type EvaluateResearchQueryStrategyRequest = z.infer<typeof EvaluateResearchQueryStrategyRequestSchema>;

export const EvaluateResearchQueryStrategyResponseSchema = z.object({
  strategy: ResearchQueryStrategySchema,
}).strict();
export type EvaluateResearchQueryStrategyResponse = z.infer<typeof EvaluateResearchQueryStrategyResponseSchema>;

export const RetryResearchQueryProviderRequestSchema = z.object({
  project_id: z.string().uuid(),
  credentials: z.record(z.string().trim().min(1)).optional(),
  execution: z.object({
    model_provider_id: z.string().trim().min(1).optional(),
    model_name: z.string().trim().min(1).optional(),
  }).strict().optional(),
}).strict();
export type RetryResearchQueryProviderRequest = z.infer<typeof RetryResearchQueryProviderRequestSchema>;

export const RetryResearchQueryProviderResponseSchema = z.object({
  strategy: ResearchQueryStrategySchema,
}).strict();
export type RetryResearchQueryProviderResponse = z.infer<typeof RetryResearchQueryProviderResponseSchema>;

export const MaterializeResearchQueryStrategyRequestSchema = z.object({
  provider_keys: z.array(ResearchProviderKeySchema).min(1).max(4),
  credentials: z.record(z.string().trim().min(1)).optional(),
}).strict();
export type MaterializeResearchQueryStrategyRequest = z.infer<typeof MaterializeResearchQueryStrategyRequestSchema>;

export const MaterializedResearchSourceSchema = z.object({
  provider_key: ResearchProviderKeySchema,
  research_query_attempt_id: z.string().uuid(),
  source_channel_id: z.string().uuid(),
  project_source_binding_id: z.string().uuid(),
  query_fingerprint: z.string().min(16).max(128),
}).strict();
export type MaterializedResearchSource = z.infer<typeof MaterializedResearchSourceSchema>;

export const MaterializeResearchQueryStrategyResponseSchema = z.object({
  query_strategy_id: z.string().uuid(),
  project_id: z.string().uuid(),
  status: z.literal("materialized"),
  sources: z.array(MaterializedResearchSourceSchema).min(1).max(4),
}).strict();
export type MaterializeResearchQueryStrategyResponse = z.infer<typeof MaterializeResearchQueryStrategyResponseSchema>;

export const ActivateResearchQueryStrategyRequestSchema = z.object({
  reason: z.enum(["manual", "rollback"]),
}).strict();
export type ActivateResearchQueryStrategyRequest = z.infer<typeof ActivateResearchQueryStrategyRequestSchema>;

export const ActivateResearchQueryStrategyResponseSchema = z.object({
  strategy_id: z.string().uuid(),
  previous_strategy_id: z.string().uuid().nullable(),
  sequence: z.number().int().min(1),
  channel_ids: z.array(z.string().uuid()).min(1).max(4),
}).strict();
export type ActivateResearchQueryStrategyResponse = z.infer<typeof ActivateResearchQueryStrategyResponseSchema>;
