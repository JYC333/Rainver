/**
 * Claim review-loop contracts (Slice E — claim trajectory + contradiction loop).
 *
 * Two advisory/proposal-first surfaces on top of the existing global claim model:
 *
 * 1. Claim trajectory — read-only change-over-time signals for the visible
 *    claims about one subject (or one claim's subject). Advisory only: it never
 *    writes canonical claims/relations and only reads viewer-visible claims, so
 *    it cannot leak hidden claim existence. The Think entry point may attach
 *    these signals to its claim provenance.
 *
 * 2. Contradiction discovery scan — an access-safe, deterministic maintenance
 *    pass that groups visible active claims by subject and flags likely
 *    contradictions (negation / numeric opposition / status disagreement),
 *    batched and confidence-tiered. The report is persisted as an owner-private
 *    (or `space_ops`) artifact; turning it into proposals reuses the existing
 *    Claim Candidate Packet flow, so the only canonical writes remain
 *    proposal-gated `object_relation_create` (contradicts) children.
 */
import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

const ReviewScopeSchema = z.enum(["private", "space_ops"]);
const ConfidenceTierSchema = z.enum(["high", "medium", "low"]);

// --- Claim trajectory (advisory, read-only) ---------------------------------

export const ClaimTrajectoryRequestSchema = z
  .object({
    subject_object_id: IdSchema.optional(),
    claim_id: IdSchema.optional(),
    limit: z.number().int().positive().max(200).default(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.subject_object_id && !value.claim_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subject_object_id or claim_id is required",
        path: ["subject_object_id"],
      });
    }
  });
export type ClaimTrajectoryRequest = z.infer<typeof ClaimTrajectoryRequestSchema>;

export const ClaimTrajectoryPointSchema = z
  .object({
    claim_id: IdSchema,
    title: z.string(),
    claim_kind: z.string(),
    status: z.string(),
    resolution_state: z.string(),
    confidence: z.number().nullable(),
    holder_label: z.string().nullable().default(null),
    valid_from: z.string().nullable().default(null),
    valid_until: z.string().nullable().default(null),
    observed_at: z.string().nullable().default(null),
    created_at: z.string(),
  })
  .strict();
export type ClaimTrajectoryPoint = z.infer<typeof ClaimTrajectoryPointSchema>;

export const ClaimTrajectorySignalKindSchema = z.enum([
  "status_change",
  "resolution_change",
  "confidence_shift",
  "supersession",
  "kind_divergence",
]);
export type ClaimTrajectorySignalKind = z.infer<typeof ClaimTrajectorySignalKindSchema>;

export const ClaimTrajectorySignalSchema = z
  .object({
    kind: ClaimTrajectorySignalKindSchema,
    from_claim_id: IdSchema,
    to_claim_id: IdSchema,
    summary: z.string(),
    confidence_tier: ConfidenceTierSchema,
  })
  .strict();
export type ClaimTrajectorySignal = z.infer<typeof ClaimTrajectorySignalSchema>;

export const ClaimTrajectoryAccessSafetySchema = z
  .object({
    advisory_only: z.literal(true),
    only_visible_claims: z.literal(true),
    raw_private_content_included: z.literal(false),
    hidden_claim_counts_included: z.literal(false),
  })
  .strict();

export const ClaimTrajectoryResponseSchema = z
  .object({
    generated_at: ISODateTimeSchema,
    space_id: IdSchema,
    subject_object_id: IdSchema.nullable().default(null),
    subject_text: z.string().nullable().default(null),
    points: z.array(ClaimTrajectoryPointSchema).default([]),
    signals: z.array(ClaimTrajectorySignalSchema).default([]),
    access_safety: ClaimTrajectoryAccessSafetySchema,
    canonical_write_performed: z.literal(false),
    ...SecretResponseGuards,
  })
  .strict();
export type ClaimTrajectoryResponse = z.infer<typeof ClaimTrajectoryResponseSchema>;

// --- Contradiction discovery scan -------------------------------------------

export const ClaimContradictionScanRequestSchema = z
  .object({
    subject_object_id: IdSchema.optional(),
    // Visible-active-claim pool to examine (the scan is pairwise within subject
    // groups, so the pool is bounded, not the finding count).
    limit: z.number().int().positive().max(500).default(200),
    max_findings: z.number().int().positive().max(200).default(40),
    review_scope: ReviewScopeSchema.default("private"),
    // When true the report artifact is immediately turned into a Claim Candidate
    // Packet (reusing that route), whose accept creates the child
    // `object_relation_create` (contradicts) proposals.
    create_packet: z.boolean().default(false),
    llm_judge_enabled: z.boolean().default(false),
  })
  .strict();
export type ClaimContradictionScanRequest = z.infer<typeof ClaimContradictionScanRequestSchema>;

export const ClaimContradictionSignalSchema = z.enum([
  "negation",
  "numeric_opposition",
  "llm_supported",
]);
export type ClaimContradictionSignal = z.infer<typeof ClaimContradictionSignalSchema>;

const ClaimRefSchema = z
  .object({ claim_id: IdSchema, title: z.string() })
  .strict();

export const ClaimContradictionProposedActionSchema = z
  .object({
    proposal_type: z.literal("object_relation_create"),
    from_object_id: IdSchema,
    to_object_id: IdSchema,
    link_type: z.literal("contradicts"),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const ClaimContradictionFindingSchema = z
  .object({
    cluster_key: z.string(),
    signal: ClaimContradictionSignalSchema,
    confidence_tier: ConfidenceTierSchema,
    from_claim: ClaimRefSchema,
    to_claim: ClaimRefSchema,
    reason: z.string(),
    proposed_action: ClaimContradictionProposedActionSchema.nullable().default(null),
  })
  .strict();
export type ClaimContradictionFinding = z.infer<typeof ClaimContradictionFindingSchema>;

export const ClaimContradictionReportSchema = z
  .object({
    findings: z.array(ClaimContradictionFindingSchema).default([]),
    counts: z.record(z.number()).default({}),
    candidates_examined: z.number().int().nonnegative().default(0),
    scanned: z.number().int().nonnegative().default(0),
    truncated: z.boolean().default(false),
    access_safety: z
      .object({
        only_visible_claims: z.literal(true),
        raw_private_content_included: z.literal(false),
        hidden_claim_counts_included: z.literal(false),
        deterministic_judge: z.literal(true),
        source_policy_enforced: z.literal(true),
        llm_judge_requested: z.boolean().default(false),
        llm_judge_used: z.boolean().default(false),
      })
      .strict(),
    llm_judge: z.record(z.unknown()).default({}),
  })
  .strict();
export type ClaimContradictionReport = z.infer<typeof ClaimContradictionReportSchema>;

export const ClaimContradictionScanResponseSchema = z
  .object({
    generated_at: ISODateTimeSchema,
    space_id: IdSchema,
    report: ClaimContradictionReportSchema,
    artifact_id: IdSchema.optional(),
    candidate_packet_proposal_id: IdSchema.optional(),
    candidate_packet_artifact_id: IdSchema.optional(),
    candidate_count: z.number().int().nonnegative().optional(),
    canonical_write_performed: z.literal(false),
    ...SecretResponseGuards,
  })
  .strict();
export type ClaimContradictionScanResponse = z.infer<typeof ClaimContradictionScanResponseSchema>;

export const CLAIM_CONTRADICTION_REPORT_ARTIFACT_TYPE = "claim_contradiction_report";
