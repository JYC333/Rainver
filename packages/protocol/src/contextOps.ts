/**
 * Context Ops read-model contracts.
 *
 * These schemas describe aggregate, UI-facing context health summaries. They do
 * not expose raw retrieval candidates, snippets, private memory text, or hidden
 * object counts.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

export const ContextOpsCountMapSchema = z.record(z.number().int().nonnegative());
export type ContextOpsCountMap = z.infer<typeof ContextOpsCountMapSchema>;

export const ContextOpsTimestampSchema = ISODateTimeSchema.nullable();

export const ContextOpsIndexFreshnessSchema = z
  .object({
    object_counts: ContextOpsCountMapSchema,
    stale_projection_count: z.number().int().nonnegative(),
    source_connected_object_count: z.number().int().nonnegative(),
    oldest_indexed_at: ContextOpsTimestampSchema,
    newest_indexed_at: ContextOpsTimestampSchema,
    newest_source_updated_at: ContextOpsTimestampSchema,
    ...SecretResponseGuards,
  })
  .strict();

export const ContextOpsEmbeddingBacklogSchema = z
  .object({
    total_chunks: z.number().int().nonnegative(),
    embedded_chunks: z.number().int().nonnegative(),
    missing_embedding_chunks: z.number().int().nonnegative(),
    claimed_chunks: z.number().int().nonnegative(),
    attempted_chunks: z.number().int().nonnegative(),
    missing_by_object_type: ContextOpsCountMapSchema,
    ...SecretResponseGuards,
  })
  .strict();

export const ContextOpsSourcePolicyWarningsSchema = z
  .object({
    active_source_connections: z.number().int().nonnegative(),
    missing_consent_version_count: z.number().int().nonnegative(),
    reader_restricted_source_count: z.number().int().nonnegative(),
    external_egress_disabled_source_count: z.number().int().nonnegative(),
    derived_writes_disabled_source_count: z.number().int().nonnegative(),
    warning_counts: ContextOpsCountMapSchema,
    ...SecretResponseGuards,
  })
  .strict();

export const ContextOpsArtifactSummarySchema = z
  .object({
    artifact_id: IdSchema,
    artifact_type: z.string(),
    title: z.string(),
    created_at: ISODateTimeSchema,
    surface: z.string().nullable(),
    diagnostic_codes: z.array(z.string()).default([]),
    finding_count: z.number().int().nonnegative().nullable(),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextOpsArtifactSummary = z.infer<typeof ContextOpsArtifactSummarySchema>;

export const ContextOpsPacketSummarySchema = z
  .object({
    proposal_id: IdSchema,
    proposal_type: z.string(),
    status: z.string(),
    title: z.string(),
    created_at: ISODateTimeSchema,
    report_artifact_id: IdSchema.nullable(),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextOpsPacketSummary = z.infer<typeof ContextOpsPacketSummarySchema>;

export const ContextOpsMaintenanceSummarySchema = z
  .object({
    recent_report_count: z.number().int().nonnegative(),
    finding_counts: ContextOpsCountMapSchema,
    pending_packet_count: z.number().int().nonnegative(),
    recent_packets: z.array(ContextOpsPacketSummarySchema),
    ...SecretResponseGuards,
  })
  .strict();

export const ContextOpsDiagnosticsSummarySchema = z
  .object({
    recent_report_count: z.number().int().nonnegative(),
    diagnostic_code_counts: ContextOpsCountMapSchema,
    latest_report_artifact_id: IdSchema.nullable(),
    latest_generated_at: ContextOpsTimestampSchema,
    trend_metric_deltas: z.record(z.number()),
    insufficient_trend_sample: z.boolean(),
    ...SecretResponseGuards,
  })
  .strict();

export const ContextOpsRetrievalFeedbackSummarySchema = z
  .object({
    recent_event_count: z.number().int().nonnegative(),
    signal_counts: ContextOpsCountMapSchema,
    surface_counts: ContextOpsCountMapSchema,
    window_days: z.number().int().positive(),
    ...SecretResponseGuards,
  })
  .strict();

export const ContextOpsMemoryProvenanceSummarySchema = z
  .object({
    recent_access_count: z.number().int().nonnegative(),
    context_injection_count: z.number().int().nonnegative(),
    maintenance_scan_count: z.number().int().nonnegative(),
    inspector_available: z.boolean(),
    ...SecretResponseGuards,
  })
  .strict();

export const ContextOpsSummarySchema = z
  .object({
    generated_at: ISODateTimeSchema,
    space_id: IdSchema,
    owner_user_id: IdSchema,
    window_days: z.number().int().positive(),
    index_freshness: ContextOpsIndexFreshnessSchema,
    embedding_backlog: ContextOpsEmbeddingBacklogSchema,
    source_policy_warnings: ContextOpsSourcePolicyWarningsSchema,
    maintenance: ContextOpsMaintenanceSummarySchema,
    diagnostics: ContextOpsDiagnosticsSummarySchema,
    recent_context_briefs: z.array(ContextOpsArtifactSummarySchema),
    retrieval_feedback: ContextOpsRetrievalFeedbackSummarySchema,
    memory_provenance: ContextOpsMemoryProvenanceSummarySchema,
    ...SecretResponseGuards,
  })
  .strict();
export type ContextOpsSummary = z.infer<typeof ContextOpsSummarySchema>;

/**
 * Context Ops drill-down contracts (Slice 3).
 *
 * Drill-downs turn an aggregate summary section into a bounded, access-safe
 * detail list. Object-level sections (`index_freshness`, `embedding_backlog`)
 * carry only live-revalidated, viewer-readable objects — title is the
 * authoritative revalidated title, never a projection snippet. The
 * `source_warnings` section carries source connections the viewer owns (or, for
 * owners/admins, all active connections) with policy warning labels only — never
 * consent/credential payloads. No raw retrieval internals, snippets, hidden
 * object ids, or dropped candidate ids cross this boundary.
 */
// Object/source sections list live-revalidated detail; the artifact sections
// (`maintenance_reports`, `diagnostics_reports`, `recent_briefs`) list the
// viewer's own (or allowed `space_ops`) aggregate-safe report/packet summaries so
// the operator can triage a specific finding instead of a bare count.
export const ContextOpsDrilldownSectionSchema = z.enum([
  "index_freshness",
  "embedding_backlog",
  "source_warnings",
  "maintenance_reports",
  "diagnostics_reports",
  "explain_reports",
  "recent_briefs",
]);
export type ContextOpsDrilldownSection = z.infer<typeof ContextOpsDrilldownSectionSchema>;

export const ContextOpsDrilldownObjectSchema = z
  .object({
    object_type: z.string(),
    object_id: IdSchema,
    title: z.string(),
    indexed_at: ContextOpsTimestampSchema,
    source_updated_at: ContextOpsTimestampSchema,
    missing_chunk_count: z.number().int().nonnegative().nullable(),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextOpsDrilldownObject = z.infer<typeof ContextOpsDrilldownObjectSchema>;

export const ContextOpsSourceWarningDetailSchema = z
  .object({
    source_connection_id: IdSchema,
    name: z.string(),
    owner_user_id: IdSchema,
    status: z.string(),
    warnings: z.array(z.string()),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextOpsSourceWarningDetail = z.infer<typeof ContextOpsSourceWarningDetailSchema>;

export const ContextOpsDrilldownSchema = z
  .object({
    generated_at: ISODateTimeSchema,
    space_id: IdSchema,
    section: ContextOpsDrilldownSectionSchema,
    limit: z.number().int().positive(),
    truncated: z.boolean(),
    objects: z.array(ContextOpsDrilldownObjectSchema).default([]),
    sources: z.array(ContextOpsSourceWarningDetailSchema).default([]),
    // Populated only for the artifact sections; aggregate-safe report/packet
    // summaries (ids, types, counts, diagnostic codes), never raw findings.
    artifacts: z.array(ContextOpsArtifactSummarySchema).default([]),
    packets: z.array(ContextOpsPacketSummarySchema).default([]),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextOpsDrilldown = z.infer<typeof ContextOpsDrilldownSchema>;

export const ContextReviewCycleRequestSchema = z
  .object({
    window_days: z.number().int().positive().max(90).default(14),
    artifact_limit: z.number().int().positive().max(200).default(50),
    create_packets: z.boolean().default(true),
    review_scope: z.enum(["private", "space_ops"]).default("private"),
    include_memory_maintenance: z.boolean().default(true),
    memory_limit: z.number().int().positive().max(1000).default(500),
    memory_stale_after_days: z.number().int().positive().max(3650).default(180),
    memory_thin_content_chars: z.number().int().positive().max(1000).default(80),
    memory_max_findings: z.number().int().positive().max(200).default(100),
    max_claim_candidates: z.number().int().positive().max(100).default(40),
  })
  .strict();
export type ContextReviewCycleRequest = z.infer<typeof ContextReviewCycleRequestSchema>;
export type ContextReviewCycleRequestInput = z.input<typeof ContextReviewCycleRequestSchema>;

export const ContextOpsContextObservationScanRequestSchema = z
  .object({
    window_days: z.number().int().positive().max(90).default(1),
    limit: z.number().int().positive().max(100).default(25),
    persist_report: z.boolean().default(true),
  })
  .strict();
export type ContextOpsContextObservationScanRequest = z.infer<
  typeof ContextOpsContextObservationScanRequestSchema
>;
export type ContextOpsContextObservationScanRequestInput = z.input<typeof ContextOpsContextObservationScanRequestSchema>;

export const ContextObservationSeveritySchema = z.enum(["red", "yellow", "green"]);
export type ContextObservationSeverity = z.infer<typeof ContextObservationSeveritySchema>;

export const ContextObservationItemSchema = z
  .object({
    severity: ContextObservationSeveritySchema,
    title: z.string(),
    summary: z.string(),
    source_refs: z.array(z.record(z.unknown())).default([]),
    suggested_target: z
      .enum(["memory", "knowledge", "capability", "assistant_preference", "review_only"])
      .default("review_only"),
  })
  .strict();
export type ContextObservationItem = z.infer<typeof ContextObservationItemSchema>;

export const ContextOpsContextObservationReportSchema = z
  .object({
    kind: z.literal("context_observation_report"),
    version: z.literal(1),
    generated_at: ISODateTimeSchema,
    space_id: IdSchema,
    owner_user_id: IdSchema,
    window_days: z.number().int().positive(),
    observations: z.array(ContextObservationItemSchema),
    counts: ContextOpsCountMapSchema,
    source_refs: z.array(z.record(z.unknown())).default([]),
    access_safety: z
      .object({
        aggregate_or_review_refs_only: z.literal(true),
        raw_private_content_included: z.literal(false),
        canonical_write_performed: z.literal(false),
      })
      .strict(),
    canonical_write_performed: z.literal(false),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextOpsContextObservationReport = z.infer<
  typeof ContextOpsContextObservationReportSchema
>;

export const ContextOpsContextObservationScanResponseSchema = z
  .object({
    report: ContextOpsContextObservationReportSchema,
    artifact_id: IdSchema.nullable(),
    canonical_write_performed: z.literal(false),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextOpsContextObservationScanResponse = z.infer<
  typeof ContextOpsContextObservationScanResponseSchema
>;

const ContextReviewCycleSectionSchema = z
  .object({
    artifact_id: IdSchema.nullable().optional(),
    proposal_id: IdSchema.nullable().optional(),
    finding_count: z.number().int().nonnegative().optional(),
    candidate_count: z.number().int().nonnegative().optional(),
    generated_child_proposal_count: z.number().int().nonnegative().optional(),
    diagnostic_codes: z.array(z.string()).optional(),
    counts: ContextOpsCountMapSchema.optional(),
    scanned: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    error_code: z.string().optional(),
    error_message: z.string().optional(),
    ...SecretResponseGuards,
  })
  .passthrough();

export const ContextReviewCycleWarningSchema = z
  .object({
    stage: z.string(),
    error_code: z.string(),
    message: z.string(),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextReviewCycleWarning = z.infer<typeof ContextReviewCycleWarningSchema>;

export const ContextReviewCycleResponseSchema = z
  .object({
    artifact_id: IdSchema,
    review_scope: z.enum(["private", "space_ops"]),
    retrieval_maintenance: ContextReviewCycleSectionSchema,
    diagnostics: ContextReviewCycleSectionSchema,
    memory_maintenance: ContextReviewCycleSectionSchema,
    claim_candidates: ContextReviewCycleSectionSchema,
    source_health: ContextOpsSourcePolicyWarningsSchema,
    projection_freshness: ContextOpsIndexFreshnessSchema,
    embedding_backlog: ContextOpsEmbeddingBacklogSchema,
    degraded: z.boolean().default(false),
    warnings: z.array(ContextReviewCycleWarningSchema).default([]),
    canonical_write_performed: z.literal(false),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextReviewCycleResponse = z.infer<typeof ContextReviewCycleResponseSchema>;
