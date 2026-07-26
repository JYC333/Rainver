/**
 * Ask Space contracts (Slice A).
 *
 * Ask Space is the unified, user-facing "ask the space a question" entry point. It
 * gathers across the viewer-visible retrieval domains (Knowledge always; Memory
 * Project public summaries, Sources, and Inquiry Threads opt-in), reusing each domain's own Context Brief
 * pipeline — so the single per-domain read gate is never duplicated and the
 * domains stay isolated. The response is read-only and proposal-first: it may
 * persist owner-private artifacts and surface follow-up actions, but it performs
 * no canonical writes (`canonical_write_performed` is always false).
 */
import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import {
  RetrievalBriefSchema,
  RetrievalObjectTypeSchema,
  RetrievalSearchModeSchema,
  RetrievalSearchResultSchema,
  RETRIEVAL_QUERY_MAX_CHARS,
} from "./knowledgeRetrieval.js";
import { ClaimTrajectorySignalSchema } from "./claimReviewLoop.js";

// The isolated retrieval domains Ask Space can gather from. Each maps to its
// own registry + read gate; they are never merged into one retrieval pass.
export const AskSpaceDomainSchema = z.enum(["knowledge", "memory", "project", "source", "inquiry"]);
export type AskSpaceDomain = z.infer<typeof AskSpaceDomainSchema>;

export const AskSpaceRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(RETRIEVAL_QUERY_MAX_CHARS),
    // Defaults to ["knowledge"] (the cheapest, least privacy-sensitive domain).
    // Memory touches the viewer's private entries + access logs, and Project
    // touches public summaries, so both are explicit opt-ins.
    domains: z.array(AskSpaceDomainSchema).min(1).max(5).optional(),
    max_results_per_domain: z.number().int().positive().max(50).optional(),
    mode: RetrievalSearchModeSchema.optional(),
    include_trace: z.boolean().optional(),
    adaptive_return: z.boolean().optional(),
    // Opt in to one cross-domain combined answer synthesized over the per-domain
    // answers. Runs only when >=2 eligible domains produced a synthesized answer
    // and a synthesis provider is available; degrades to per-domain answers
    // otherwise. Default off.
    combine: z.boolean().optional(),
    // Whether the Memory domain's answer may enter the combined prompt. Default
    // false: private Memory content is never sent into the cross-domain synthesis
    // unless the caller explicitly opts in.
    combine_include_memory: z.boolean().optional(),
    // Persist each domain's brief as an owner-private `retrieval_brief` artifact
    // plus an `ask_space_session` artifact linking them, so the answer is
    // durable and can seed a Claim Candidate Packet.
    persist: z.boolean().optional(),
    // Attach advisory claim trajectory (change-over-time) signals for any claim
    // the answer cited (Slice E). Read-only and access-safe: it only loads
    // viewer-visible sibling claims. Default off.
    include_claim_trajectory: z.boolean().optional(),
  })
  .strict();
export type AskSpaceRequest = z.infer<typeof AskSpaceRequestSchema>;

// One domain's contribution: its own cited brief, the ranked/revalidated sources
// it was built from, and the optional persisted artifact id. `brief` is null and
// `error_code` is set only when that single domain failed (others still answer).
export const AskSpaceDomainSectionSchema = z
  .object({
    domain: AskSpaceDomainSchema,
    object_types: z.array(RetrievalObjectTypeSchema).default([]),
    brief: RetrievalBriefSchema.nullable(),
    items: z.array(RetrievalSearchResultSchema).default([]),
    total: z.number().int().nonnegative().default(0),
    artifact_id: IdSchema.optional(),
    artifact_error: z.string().optional(),
    error_code: z.string().optional(),
  })
  .passthrough();
export type AskSpaceDomainSection = z.infer<typeof AskSpaceDomainSectionSchema>;

// Aggregate, access-neutral gap roll-up across the answered domains. Counts only
// — the underlying gap items already point at viewer-visible sources.
export const AskSpaceGapSummarySchema = z
  .object({
    stale_count: z.number().int().nonnegative(),
    thin_count: z.number().int().nonnegative(),
    low_coverage_domains: z.array(AskSpaceDomainSchema).default([]),
    uncited_claim_count: z.number().int().nonnegative(),
    contradiction_count: z.number().int().nonnegative(),
    missing_topic_count: z.number().int().nonnegative(),
  })
  .strict();
export type AskSpaceGapSummary = z.infer<typeof AskSpaceGapSummarySchema>;

// A cited source surfaced by the answer, tagged with the domain it came from.
// Already viewer-visible (each citation is a revalidated, surfaced source).
export const AskSpaceProvenanceItemSchema = z
  .object({
    domain: AskSpaceDomainSchema,
    object_type: RetrievalObjectTypeSchema,
    object_id: IdSchema,
    title: z.string(),
  })
  .strict();
export type AskSpaceProvenanceItem = z.infer<typeof AskSpaceProvenanceItemSchema>;

// Explicit, proposal-first next steps. Each is a data-driven action that reuses
// an EXISTING route (Claim Candidate Packet, maintenance scan); Ask Space never adds
// a new canonical write path. `source_artifact_ids` are the persisted brief
// artifacts a packet can be built from (present only when `persist` produced
// artifacts). (A standing "review proposals" navigation link is a pure UI affordance,
// not a data-driven follow-up, so it is intentionally not a kind here.)
export const AskSpaceFollowUpKindSchema = z.enum([
  "claim_candidate_packet",
  "maintenance_scan",
]);
export type AskSpaceFollowUpKind = z.infer<typeof AskSpaceFollowUpKindSchema>;

export const AskSpaceFollowUpSchema = z
  .object({
    kind: AskSpaceFollowUpKindSchema,
    label: z.string(),
    reason: z.string().optional(),
    source_artifact_ids: z.array(IdSchema).default([]),
  })
  .strict();
export type AskSpaceFollowUp = z.infer<typeof AskSpaceFollowUpSchema>;

// Advisory claim trajectory attached to a cited claim (Slice E). Signals only —
// no canonical writes, no hidden-claim leakage (the underlying scan reads only
// viewer-visible sibling claims).
export const AskSpaceClaimTrajectorySchema = z
  .object({
    claim_id: IdSchema,
    subject_object_id: IdSchema.nullable().default(null),
    subject_text: z.string().nullable().default(null),
    signals: z.array(ClaimTrajectorySignalSchema).default([]),
  })
  .strict();
export type AskSpaceClaimTrajectory = z.infer<typeof AskSpaceClaimTrajectorySchema>;

export const AskSpaceResponseSchema = z
  .object({
    generated_at: ISODateTimeSchema,
    space_id: IdSchema,
    query: z.string(),
    requested_domains: z.array(AskSpaceDomainSchema),
    domains: z.array(AskSpaceDomainSectionSchema).default([]),
    // True when at least one domain produced an LLM-synthesized answer; false
    // when every domain degraded to deterministic gap analysis only.
    synthesized: z.boolean(),
    // One cross-domain answer synthesized over the per-domain answers when
    // `combine` was requested and eligible; null otherwise (off, <2 eligible
    // domains, no provider, egress-blocked, or a provider failure). Built ONLY
    // from already-visible per-domain answers and re-gated by the same egress /
    // source-policy gate, so it never widens what reaches a provider.
    combined_answer: z.string().nullable().default(null),
    gap_summary: AskSpaceGapSummarySchema,
    provenance: z.array(AskSpaceProvenanceItemSchema).default([]),
    // Present only when `include_claim_trajectory` was requested and the answer
    // cited at least one claim. Advisory; one entry per cited claim subject.
    claim_trajectories: z.array(AskSpaceClaimTrajectorySchema).default([]),
    follow_ups: z.array(AskSpaceFollowUpSchema).default([]),
    session_artifact_id: IdSchema.optional(),
    session_artifact_error: z.string().optional(),
    canonical_write_performed: z.literal(false),
    ...SecretResponseGuards,
  })
  .strict();
export type AskSpaceResponse = z.infer<typeof AskSpaceResponseSchema>;

export const ASK_SPACE_SESSION_ARTIFACT_TYPE = "ask_space_session";
