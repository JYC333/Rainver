import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

// knowledge_item / note / source / claim are owned by the Knowledge domain adapter.
// memory_entry is owned by the Memory domain adapter. project_public_summary is
// owned by the Projects domain adapter. source_item / extracted_evidence are
// owned by the Source domain adapter. inquiry_thread is owned by the Inquiry
// domain adapter; Threads are `space_objects` rows (ADR 0011 decision 1), and
// the adapter exists for the domain fields the generic projection has no reason
// to know about. The contract is shared but each domain registers
// its own adapter into its own registry, so the surfaces stay isolated.
export const RETRIEVAL_OBJECT_TYPE_VALUES = [
  "knowledge_item",
  "note",
  "source",
  "claim",
  "memory_entry",
  "project_public_summary",
  "source_item",
  "extracted_evidence",
  "inquiry_thread",
] as const;

export const RetrievalObjectTypeSchema = z.enum(RETRIEVAL_OBJECT_TYPE_VALUES);
export type RetrievalObjectType = z.infer<typeof RetrievalObjectTypeSchema>;

export const RetrievalObjectProfileSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
export type RetrievalObjectProfile = z.infer<typeof RetrievalObjectProfileSchema>;

export const EvidenceKindSchema = z.enum([
  "alias_hit",
  "exact_title_match",
  "slug_match",
  "source_url_match",
  "lexical_match",
  "vector_match",
  "graph_neighbor",
  "weak_match",
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const CreateSafetySchema = z.enum(["exists", "probable_duplicate", "unknown"]);
export type CreateSafety = z.infer<typeof CreateSafetySchema>;

export const EvidenceContractSchema = z
  .object({
    kind: EvidenceKindSchema,
    field: z.string().optional(),
    matched_text: z.string().optional(),
    source: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();
export type EvidenceContract = z.infer<typeof EvidenceContractSchema>;

export const RetrievalSearchResultSchema = z
  .object({
    object_type: RetrievalObjectTypeSchema,
    object_id: IdSchema,
    object_profile: RetrievalObjectProfileSchema.nullish(),
    object_profile_label: z.string().min(1).max(160).nullish(),
    title: z.string(),
    snippet: z.string().nullable(),
    score: z.number(),
    evidence: EvidenceContractSchema,
    create_safety: CreateSafetySchema.optional(),
    matched_fields: z.array(z.string()).default([]),
    source_refs: z.array(z.record(z.unknown())).optional(),
    trace: z.record(z.unknown()).optional(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RetrievalSearchResult = z.infer<typeof RetrievalSearchResultSchema>;

// Search-mode tiers, cheapest → most expensive. They select which arms and LLM
// stages run, and are the primary cost/token budget lever:
//   exact         — exact/alias/slug/url matching only (no lexical/vector/graph).
//   lexical       — deterministic Phase-1 recall: exact + lexical + graph.
//   hybrid        — lexical tier + the vector recall arm (no LLM rerank).
//   hybrid_rerank — hybrid + the post-revalidate LLM reranker.
// The LLM stages are opt-in: rerank only runs in `hybrid_rerank`, and query
// rewriting only when `rewrite` is true (and the mode runs the free-text arms).
export const RetrievalSearchModeSchema = z.enum(["exact", "lexical", "hybrid", "hybrid_rerank"]);
export type RetrievalSearchMode = z.infer<typeof RetrievalSearchModeSchema>;

// Cap the query length: it is sent verbatim to providers (embedding / rewrite /
// rerank prompt) and into lexical SQL, so an unbounded query is a cost/abuse vector.
export const RETRIEVAL_QUERY_MAX_CHARS = 1024;
export const RETRIEVAL_EMBEDDING_DIMENSIONS_MIN = 64;
export const RETRIEVAL_EMBEDDING_DIMENSIONS_MAX = 4096;

export const RetrievalSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(RETRIEVAL_QUERY_MAX_CHARS),
  object_types: z.array(RetrievalObjectTypeSchema).optional(),
  object_profiles: z.array(RetrievalObjectProfileSchema).max(20).optional(),
  // Result budget. The compute/token budget is the `mode` tier above.
  max_results: z.number().int().positive().max(50).optional(),
  include_trace: z.boolean().optional(),
  // Defaults to `hybrid` (all recall arms, no LLM rerank).
  mode: RetrievalSearchModeSchema.optional(),
  // Opt in to the pre-recall LLM query rewriter. Ignored in `exact` mode and when
  // no rewriter is configured. Defaults to off.
  rewrite: z.boolean().optional(),
  // Reuse the per-process query-embedding cache for the vector arm (default true).
  // `false` forces a fresh embedding (e.g. after a model swap).
  use_cache: z.boolean().optional(),
  // Opt in per request to conservative tail trimming after final ranking.
  adaptive_return: z.boolean().optional(),
});
export type RetrievalSearchRequest = z.infer<typeof RetrievalSearchRequestSchema>;

export const RetrievalSearchResponseSchema = z
  .object({
    items: z.array(RetrievalSearchResultSchema),
    total: z.number().int().nonnegative(),
    // Results discovered via query-rewrite variants, kept SEPARATE from `items`:
    // they are never blended into or co-ranked with the original-query results.
    // Present only when query rewriting ran and produced additional matches.
    rewrite_items: z.array(RetrievalSearchResultSchema).optional(),
    rewrite_total: z.number().int().nonnegative().optional(),
    trace: z.record(z.unknown()).optional(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RetrievalSearchResponse = z.infer<typeof RetrievalSearchResponseSchema>;

// ── Context Brief (W6): synthesis + citations + gap analysis over the retrieved
// sources. The brief is built only from the viewer-visible, revalidated results;
// citations point at those surfaced sources, and gap findings are advisory output
// (maintenance/report/proposal-packet flows may turn them into review candidates;
// never a canonical write from this response).
export const RetrievalCitationSchema = z
  .object({
    object_type: RetrievalObjectTypeSchema,
    object_id: IdSchema,
    object_profile: RetrievalObjectProfileSchema.nullish(),
    object_profile_label: z.string().min(1).max(160).nullish(),
    title: z.string(),
  })
  .passthrough();
export type RetrievalCitation = z.infer<typeof RetrievalCitationSchema>;

// A surfaced source flagged by a deterministic gap signal (stale / thin), with a
// human-readable reason. object_type/object_id/title are already viewer-visible.
export const RetrievalGapItemSchema = z
  .object({
    object_type: RetrievalObjectTypeSchema,
    object_id: IdSchema,
    object_profile: RetrievalObjectProfileSchema.nullish(),
    object_profile_label: z.string().min(1).max(160).nullish(),
    title: z.string(),
    reason: z.string(),
  })
  .passthrough();
export type RetrievalGapItem = z.infer<typeof RetrievalGapItemSchema>;

export const RetrievalGapAnalysisSchema = z
  .object({
    // Deterministic, access-neutral signals (each from a source's own metadata).
    stale: z.array(RetrievalGapItemSchema).default([]),
    thin: z.array(RetrievalGapItemSchema).default([]),
    low_coverage: z.boolean().default(false),
    // LLM signals ("what the compiled context does not cover"); empty when synthesis did not run.
    uncited_claims: z.array(z.string()).default([]),
    contradictions: z.array(z.string()).default([]),
    missing_topics: z.array(z.string()).default([]),
  })
  .passthrough();
export type RetrievalGapAnalysis = z.infer<typeof RetrievalGapAnalysisSchema>;

export const RetrievalBriefSchema = z
  .object({
    // The synthesized answer (may cite sources as [n]); null when synthesis did
    // not run (no provider configured, opted out, or a provider failure).
    answer: z.string().nullable(),
    synthesized: z.boolean(),
    citations: z.array(RetrievalCitationSchema).default([]),
    gap_analysis: RetrievalGapAnalysisSchema,
  })
  .passthrough();
export type RetrievalBrief = z.infer<typeof RetrievalBriefSchema>;

export const RetrievalBriefRequestSchema = z.object({
  query: z.string().trim().min(1).max(RETRIEVAL_QUERY_MAX_CHARS),
  object_types: z.array(RetrievalObjectTypeSchema).optional(),
  object_profiles: z.array(RetrievalObjectProfileSchema).max(20).optional(),
  max_results: z.number().int().positive().max(50).optional(),
  mode: RetrievalSearchModeSchema.optional(),
  include_trace: z.boolean().optional(),
  adaptive_return: z.boolean().optional(),
  persist_artifact: z.boolean().optional(),
});
export type RetrievalBriefRequest = z.infer<typeof RetrievalBriefRequestSchema>;

export const RetrievalBriefResponseSchema = z
  .object({
    brief: RetrievalBriefSchema,
    // The ranked, revalidated sources the brief was built from.
    items: z.array(RetrievalSearchResultSchema),
    total: z.number().int().nonnegative(),
    trace: z.record(z.unknown()).optional(),
    artifact_id: IdSchema.optional(),
    artifact_error: z.string().optional(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RetrievalBriefResponse = z.infer<typeof RetrievalBriefResponseSchema>;

// ── Maintenance scan (W7, "context review cycle"): a READ-ONLY, batched report of review
// candidates over the derived projection — duplicates, orphan pages, thin pages,
// and suggested relations. It never writes canonical data; acting on a finding
// stays on the existing proposal/approval flow.
export const RetrievalMaintenanceFindingKindSchema = z.enum([
  "duplicate",
  "orphan",
  "thin",
  "stale",
  "relation_suggestion",
]);
export type RetrievalMaintenanceFindingKind = z.infer<typeof RetrievalMaintenanceFindingKindSchema>;

export const RetrievalMaintenanceObjectSchema = z
  .object({
    object_type: RetrievalObjectTypeSchema,
    object_id: IdSchema,
    title: z.string(),
  })
  .passthrough();
export type RetrievalMaintenanceObject = z.infer<typeof RetrievalMaintenanceObjectSchema>;

export const RetrievalMaintenanceFindingSchema = z
  .object({
    kind: RetrievalMaintenanceFindingKindSchema,
    // The clustered objects: a duplicate group, a single orphan/thin page, or a
    // relation's two endpoints. Each is already viewer-visible (revalidated).
    objects: z.array(RetrievalMaintenanceObjectSchema),
    reason: z.string(),
    proposed_action: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();
export type RetrievalMaintenanceFinding = z.infer<typeof RetrievalMaintenanceFindingSchema>;

export const RetrievalMaintenanceScanRequestSchema = z.object({
  persist_report: z.boolean().optional(),
  create_packet: z.boolean().optional(),
  review_scope: z.enum(["private", "space_ops"]).default("private"),
});
export type RetrievalMaintenanceScanRequest = z.infer<typeof RetrievalMaintenanceScanRequestSchema>;

export const RetrievalMaintenanceReportSchema = z
  .object({
    findings: z.array(RetrievalMaintenanceFindingSchema),
    counts: z.record(z.number().int().nonnegative()),
    scanned: z.number().int().nonnegative(),
    truncated: z.boolean(),
    artifact_id: IdSchema.optional(),
    proposal_id: IdSchema.optional(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RetrievalMaintenanceReport = z.infer<typeof RetrievalMaintenanceReportSchema>;

const RetrievalEvalKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9_.:-]+$/, "keys may only contain letters, numbers, underscore, dash, colon, and dot");

const RetrievalEvalMetricMapSchema = z
  .record(z.number().refine(Number.isFinite, "metric values must be finite"))
  .refine(
    (value) => Object.keys(value).every((key) => RetrievalEvalKeySchema.safeParse(key).success),
    "metric keys may only contain letters, numbers, underscore, dash, colon, and dot",
  );

const RetrievalEvalCountMapSchema = z
  .record(z.number().int().nonnegative())
  .refine(
    (value) => Object.keys(value).every((key) => RetrievalEvalKeySchema.safeParse(key).success),
    "count keys may only contain letters, numbers, underscore, dash, colon, and dot",
  );

const RetrievalEvalDiagnosticCodeSchema = RetrievalEvalKeySchema.max(96);

export const RetrievalEvalReportCaseSchema = z
  .object({
    case_label: z.string().trim().min(1).max(128),
    object_type: RetrievalObjectTypeSchema.optional(),
    mode: RetrievalSearchModeSchema.optional(),
    k: z.number().int().positive().max(100).optional(),
    metrics: RetrievalEvalMetricMapSchema.default({}),
    expected_count: z.number().int().nonnegative().max(10000).optional(),
    returned_count: z.number().int().nonnegative().max(10000).optional(),
    hit_count: z.number().int().nonnegative().max(10000).optional(),
    first_relevant_rank: z.number().int().positive().max(10000).nullable().optional(),
    diagnostic_codes: z.array(RetrievalEvalDiagnosticCodeSchema).max(20).default([]),
  })
  .strict();
export type RetrievalEvalReportCase = z.infer<typeof RetrievalEvalReportCaseSchema>;

export const RetrievalEvalRankAttributionSchema = z
  .object({
    evidence_kind_counts: RetrievalEvalCountMapSchema.default({}),
    matched_field_counts: RetrievalEvalCountMapSchema.default({}),
    score_buckets: RetrievalEvalCountMapSchema.default({}),
  })
  .strict();
export type RetrievalEvalRankAttribution = z.infer<typeof RetrievalEvalRankAttributionSchema>;

// P2 eval/explain artifact input. This shape is intentionally aggregate-only:
// no candidate ids, titles, snippets, or arbitrary content fields are accepted.
export const RetrievalEvalReportRequestSchema = z
  .object({
    source: z.string().trim().min(1).max(96).default("manual"),
    suite: z.string().trim().min(1).max(128).optional(),
    report_label: z.string().trim().min(1).max(128).optional(),
    k: z.number().int().positive().max(100).optional(),
    metrics: RetrievalEvalMetricMapSchema.default({}),
    counts: RetrievalEvalCountMapSchema.default({}),
    cases: z.array(RetrievalEvalReportCaseSchema).max(500).default([]),
    rank_attribution: RetrievalEvalRankAttributionSchema.default({}),
    diagnostic_codes: z.array(RetrievalEvalDiagnosticCodeSchema).max(50).default([]),
  })
  .strict();
export type RetrievalEvalReportRequest = z.infer<typeof RetrievalEvalReportRequestSchema>;

export const RetrievalEvalReportPersistResponseSchema = z.object({
  artifact_id: IdSchema,
});
export type RetrievalEvalReportPersistResponse = z.infer<typeof RetrievalEvalReportPersistResponseSchema>;

export const RetrievalEvalDiagnosticsReportRequestSchema = z
  .object({
    window_days: z.number().int().positive().max(365).default(30),
    limit: z.number().int().positive().max(1000).default(200),
    report_label: z.string().trim().min(1).max(128).optional(),
    include_maintenance_reports: z.boolean().default(true),
    compare_previous_window: z.boolean().default(true),
    create_packet: z.boolean().default(false),
    review_scope: z.enum(["private", "space_ops"]).default("private"),
  })
  .strict();
export type RetrievalEvalDiagnosticsReportRequest = z.infer<typeof RetrievalEvalDiagnosticsReportRequestSchema>;

export const RetrievalEvalDiagnosticsReportResponseSchema = RetrievalEvalReportPersistResponseSchema.extend({
  counts: RetrievalEvalCountMapSchema,
  diagnostic_codes: z.array(RetrievalEvalDiagnosticCodeSchema).max(50),
  proposal_id: IdSchema.optional(),
});
export type RetrievalEvalDiagnosticsReportResponse = z.infer<typeof RetrievalEvalDiagnosticsReportResponseSchema>;

export const RetrievalCalibrationMechanicSchema = z.enum([
  "visible_edge_backlink",
  "candidate_owned_salience",
  "richer_dedup",
  "autocut",
  "semantic_results_cache",
]);
export type RetrievalCalibrationMechanic = z.infer<typeof RetrievalCalibrationMechanicSchema>;

export const RetrievalCalibrationDecisionSchema = z
  .object({
    mechanic: RetrievalCalibrationMechanicSchema,
    decision: z.enum(["adopt", "defer", "reject"]),
    access_safety_proof: z.string().trim().min(1).max(2000),
    eval_delta: RetrievalEvalMetricMapSchema.default({}),
    evidence_artifact_ids: z.array(IdSchema).max(12).default([]),
    rationale: z.string().trim().max(4000).optional(),
    guardrails: z.array(z.string().trim().min(1).max(240)).max(20).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "adopt" && Object.keys(value.eval_delta).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eval_delta"],
        message: "adopt decisions require non-empty eval_delta",
      });
    }
    if (value.decision === "adopt" && value.evidence_artifact_ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_artifact_ids"],
        message: "adopt decisions require at least one evidence artifact",
      });
    }
    if (value.mechanic === "semantic_results_cache" && value.decision === "adopt") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision"],
        message: "cross-viewer semantic results cache must stay rejected",
      });
    }
  });
export type RetrievalCalibrationDecision = z.infer<typeof RetrievalCalibrationDecisionSchema>;

export const RetrievalCalibrationDecisionRequestSchema = z
  .object({
    report_label: z.string().trim().max(160).optional(),
    suite: z.string().trim().max(160).optional(),
    decisions: z.array(RetrievalCalibrationDecisionSchema).min(1).max(10),
    review_scope: z.enum(["private", "space_ops"]).default("private"),
  })
  .strict();
export type RetrievalCalibrationDecisionRequest = z.infer<
  typeof RetrievalCalibrationDecisionRequestSchema
>;

export const RetrievalCalibrationDecisionResponseSchema = z
  .object({
    artifact_id: IdSchema,
    decision_count: z.number().int().nonnegative(),
    ...SecretResponseGuards,
  })
  .strict();
export type RetrievalCalibrationDecisionResponse = z.infer<
  typeof RetrievalCalibrationDecisionResponseSchema
>;

export const RetrievalRankingMechanicStateSchema = z.enum(["disabled", "adopted", "shipped"]);
export type RetrievalRankingMechanicState = z.infer<typeof RetrievalRankingMechanicStateSchema>;

const RetrievalRuntimeMechanicSchema = z
  .object({
    state: RetrievalRankingMechanicStateSchema.default("disabled"),
    calibration_artifact_id: IdSchema.nullish(),
    shipped_at: ISODateTimeSchema.nullish(),
    eval_gate: z
      .object({
        status: z.enum(["not_run", "passed", "failed"]).default("not_run"),
        metric: z.string().trim().min(1).max(96).nullish(),
        value: z.number().nullish(),
        threshold: z.number().default(0),
        checked_at: ISODateTimeSchema.nullish(),
      })
      .default({}),
  })
  .strict();

export const RetrievalRuntimeRankingConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    eval_gate: z
      .object({
        min_primary_metric_delta: z.number().default(0),
        required_evidence_artifacts: z.number().int().nonnegative().max(12).default(1),
      })
      .default({}),
    mechanics: z
      .object({
        visible_edge_backlink: RetrievalRuntimeMechanicSchema.default({}),
        candidate_owned_salience: RetrievalRuntimeMechanicSchema.default({}),
        richer_dedup: RetrievalRuntimeMechanicSchema.default({}),
        autocut: RetrievalRuntimeMechanicSchema.default({}),
        semantic_results_cache: RetrievalRuntimeMechanicSchema.default({ state: "disabled" }),
      })
      .default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    const cache = value.mechanics.semantic_results_cache;
    if (cache.state !== "disabled") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mechanics", "semantic_results_cache", "state"],
        message: "cross-viewer semantic results cache must stay disabled",
      });
    }
  });
export type RetrievalRuntimeRankingConfig = z.infer<typeof RetrievalRuntimeRankingConfigSchema>;

const RetrievalTraceSummarySchema = z
  .object({
    arms: RetrievalEvalCountMapSchema.default({}),
    dropped: z.number().int().nonnegative().default(0),
    dropped_reasons: RetrievalEvalCountMapSchema.default({}),
    mode: RetrievalSearchModeSchema.optional(),
    intent: z.string().optional(),
    rerank: z.record(z.unknown()).optional(),
    rewrite: z.record(z.unknown()).optional(),
    graph: z.record(z.unknown()).optional(),
    relational: z.record(z.unknown()).optional(),
    synthesis: z.record(z.unknown()).optional(),
    // Aggregate ranking telemetry (§2.8): score histogram + boost-axis fire
    // counts over the visible set, plus the adaptive-return outcome. Counts only.
    score_buckets: RetrievalEvalCountMapSchema.optional(),
    boost_attribution: RetrievalEvalCountMapSchema.optional(),
    adaptive_return: z.record(z.unknown()).optional(),
  })
  .strict();
export type RetrievalTraceSummary = z.infer<typeof RetrievalTraceSummarySchema>;

export const RetrievalExplainRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(RETRIEVAL_QUERY_MAX_CHARS),
    object_type: RetrievalObjectTypeSchema,
    object_id: IdSchema,
    object_types: z.array(RetrievalObjectTypeSchema).optional(),
    max_results: z.number().int().positive().max(50).optional(),
    mode: RetrievalSearchModeSchema.optional(),
    rewrite: z.boolean().optional(),
    use_cache: z.boolean().optional(),
    adaptive_return: z.boolean().optional(),
    persist_artifact: z.boolean().default(false),
  })
  .strict();
export type RetrievalExplainRequest = z.infer<typeof RetrievalExplainRequestSchema>;

export const RetrievalExplainResponseSchema = z
  .object({
    target: z.object({
      object_type: RetrievalObjectTypeSchema,
      object_id: IdSchema,
      title: z.string(),
      visible: z.literal(true),
      returned: z.boolean(),
      rank: z.number().int().positive().optional(),
      score: z.number().optional(),
      score_bucket: z.string().optional(),
    }),
    match: z.object({
      matched_fields: z.array(z.string()).default([]),
      evidence_kind: EvidenceKindSchema.optional(),
      evidence_field: z.string().optional(),
      evidence_source: z.string().optional(),
      evidence_confidence: z.number().min(0).max(1).optional(),
      create_safety: CreateSafetySchema.optional(),
    }),
    trace: RetrievalTraceSummarySchema,
    diagnostic_codes: z.array(RetrievalEvalDiagnosticCodeSchema).max(50),
    artifact_id: IdSchema.optional(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RetrievalExplainResponse = z.infer<typeof RetrievalExplainResponseSchema>;

// Managed-run retrieval policy. `off` (default) keeps managed runs no-tool;
// `manual_tool_only` lets an opted-in managed run call the governed
// retrieval.search / retrieval.brief tools; preflight modes run one governed
// retrieval step before the model turn and surface the result as explicit
// run evidence.
export const RetrievalToolModeSchema = z.enum([
  "off",
  "manual_tool_only",
  "preflight_search",
  "preflight_brief",
]);
export type RetrievalToolMode = z.infer<typeof RetrievalToolModeSchema>;

export const ContextOpsReviewModeSchema = z.enum(["private_only", "admins", "members"]);
export type ContextOpsReviewMode = z.infer<typeof ContextOpsReviewModeSchema>;

export const ContextOpsScanModeSchema = z.enum(["admins", "members"]);
export type ContextOpsScanMode = z.infer<typeof ContextOpsScanModeSchema>;

export const SpaceRetrievalSettingsSchema = z.object({
  space_id: IdSchema,
  default_search_mode: RetrievalSearchModeSchema,
  rerank_enabled: z.boolean(),
  query_rewrite_enabled: z.boolean(),
  query_rewrite_default: z.boolean(),
  use_query_cache: z.boolean(),
  include_trace: z.boolean(),
  // W9 egress governance: when false, this space's indexed content is never sent
  // to a model provider (embedding / rerank / synthesis); those stages are
  // skipped and retrieval degrades to the deterministic arms. Default true.
  external_egress_enabled: z.boolean(),
  // Managed-run retrieval tool exposure (default `off`).
  retrieval_tool_mode: RetrievalToolModeSchema,
  // Space-wide Context Ops packet review. Private packets remain creator-only.
  context_ops_review_mode: ContextOpsReviewModeSchema,
  // Context Ops scan initiation. Reindex routes remain owner/admin-only.
  context_ops_scan_mode: ContextOpsScanModeSchema,
  embedding_dimensions: z
    .number()
    .int()
    .min(RETRIEVAL_EMBEDDING_DIMENSIONS_MIN)
    .max(RETRIEVAL_EMBEDDING_DIMENSIONS_MAX),
  max_results_default: z.number().int().positive().max(50),
  ranking_config: RetrievalRuntimeRankingConfigSchema,
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type SpaceRetrievalSettings = z.infer<typeof SpaceRetrievalSettingsSchema>;

export const SpaceRetrievalSettingsUpdateSchema = z
  .object({
    default_search_mode: RetrievalSearchModeSchema.optional(),
    rerank_enabled: z.boolean().optional(),
    query_rewrite_enabled: z.boolean().optional(),
    query_rewrite_default: z.boolean().optional(),
    use_query_cache: z.boolean().optional(),
    include_trace: z.boolean().optional(),
    external_egress_enabled: z.boolean().optional(),
    retrieval_tool_mode: RetrievalToolModeSchema.optional(),
    context_ops_review_mode: ContextOpsReviewModeSchema.optional(),
    context_ops_scan_mode: ContextOpsScanModeSchema.optional(),
    embedding_dimensions: z
      .number()
      .int()
      .min(RETRIEVAL_EMBEDDING_DIMENSIONS_MIN)
      .max(RETRIEVAL_EMBEDDING_DIMENSIONS_MAX)
      .optional(),
    max_results_default: z.number().int().positive().max(50).optional(),
    ranking_config: RetrievalRuntimeRankingConfigSchema.optional(),
  })
  .strict();
export type SpaceRetrievalSettingsUpdate = z.infer<typeof SpaceRetrievalSettingsUpdateSchema>;

// Positive-only retrieval feedback. There is intentionally no skipped/not-clicked
// negative signal: absence of interaction is ambiguous and must not lower rank.
export const RetrievalFeedbackSignalSchema = z.enum([
  "opened",
  "dwell",
  "used",
  "explicit_relevant",
  "accepted",
  "pinned",
]);
export type RetrievalFeedbackSignal = z.infer<typeof RetrievalFeedbackSignalSchema>;

export const RetrievalFeedbackRequestSchema = z.object({
  query: z.string().trim().min(1),
  object_type: RetrievalObjectTypeSchema,
  object_id: IdSchema,
  signal_type: RetrievalFeedbackSignalSchema,
  dwell_ms: z.number().int().nonnegative().max(86_400_000).optional(),
  metadata: z
    .object({
      source: z.enum(["result_open", "dwell_timer", "explicit_action"]).optional(),
    })
    .strict()
    .optional(),
});
export type RetrievalFeedbackRequest = z.infer<typeof RetrievalFeedbackRequestSchema>;

export const RetrievalFeedbackResponseSchema = z.object({
  ok: z.literal(true),
});
export type RetrievalFeedbackResponse = z.infer<typeof RetrievalFeedbackResponseSchema>;

export const RetrievalCreateSafetyRequestSchema = z.object({
  object_type: RetrievalObjectTypeSchema,
  title: z.string().max(RETRIEVAL_QUERY_MAX_CHARS).optional(),
  slug: z.string().max(RETRIEVAL_QUERY_MAX_CHARS).optional(),
  aliases: z.array(z.string().max(RETRIEVAL_QUERY_MAX_CHARS)).optional(),
  uri: z.string().max(RETRIEVAL_QUERY_MAX_CHARS).optional(),
  // When checking create-safety while editing an existing object, pass its id so
  // the object does not flag itself as a duplicate of itself.
  exclude_object_id: IdSchema.optional(),
  max_results: z.number().int().positive().max(20).optional(),
});
export type RetrievalCreateSafetyRequest = z.infer<typeof RetrievalCreateSafetyRequestSchema>;

export const RetrievalCreateSafetyResponseSchema = z
  .object({
    create_safety: CreateSafetySchema,
    matches: z.array(RetrievalSearchResultSchema),
    evidence: z.array(EvidenceContractSchema),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RetrievalCreateSafetyResponse = z.infer<
  typeof RetrievalCreateSafetyResponseSchema
>;
