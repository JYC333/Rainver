/**
 * Candidate-relation discovery contracts (Slice F — Gap 6).
 *
 * The discovery pass reads viewer-visible note / knowledge-item text plus
 * policy-allowed Activity/Artifact text, extracts typed internal links
 * deterministically, and resolves them against other viewer-visible Knowledge
 * items. Service-level LLM extraction is injectable for future provider
 * wiring; the public HTTP route rejects the flag until that adapter exists. It
 * produces a single batched, confidence-tiered proposal packet of candidate
 * `object_relation_create` edges (and, optionally, candidate `knowledge_item`
 * stubs for unresolved targets). It is the proposal-gated analogue of the context-and-retrieval design's
 * self-wiring graph: discovery NEVER writes an edge or item directly — accepting
 * the packet only creates child pending proposals, which still go through normal
 * review. Discovery is access-safe: only visible source text and only visible
 * resolution targets are ever used, so it cannot leak hidden object existence.
 */
import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

const ReviewScopeSchema = z.enum(["private", "space_ops"]);
const ConfidenceTierSchema = z.enum(["high", "medium", "low"]);

// Source object types whose text the deterministic pass reads. Activity and
// artifact rows are review-only anchors unless a future root-object model gives
// them FK-backed relation endpoints.
export const RelationDiscoverySourceTypeSchema = z.enum(["knowledge_item", "note", "activity", "artifact"]);
export type RelationDiscoverySourceType = z.infer<typeof RelationDiscoverySourceTypeSchema>;

export const RelationDiscoveryScanRequestSchema = z
  .object({
    source_object_types: z.array(RelationDiscoverySourceTypeSchema).min(1).max(4).optional(),
    // Visible source rows to scan for links.
    limit: z.number().int().positive().max(500).default(200),
    max_candidates: z.number().int().positive().max(200).default(40),
    review_scope: ReviewScopeSchema.default("private"),
    // When true, also emit low-confidence candidate `knowledge_item` stubs for
    // wikilink targets that did NOT resolve to a visible item. Off by default —
    // resolved relations are the high-value, low-noise output.
    include_unresolved_item_candidates: z.boolean().default(false),
    llm_extraction_enabled: z.boolean().default(false),
    llm_max_sources: z.number().int().positive().max(20).default(8),
    create_packet: z.boolean().default(true),
  })
  .strict();
export type RelationDiscoveryScanRequest = z.infer<typeof RelationDiscoveryScanRequestSchema>;
export type RelationDiscoveryScanRequestInput = z.input<typeof RelationDiscoveryScanRequestSchema>;

export const RelationDiscoveryCandidateKindSchema = z.enum([
  "object_relation_candidate",
  // Activity/Artifact anchors cannot safely create FK-backed object relations
  // today. They stay as review-only evidence rows in the packet.
  "relation_review_candidate",
  "knowledge_item_candidate",
]);

const EvidenceRefSchema = z
  .object({
    object_type: z.string(),
    object_id: IdSchema,
    title: z.string().nullable().default(null),
    link_origin: z.string().nullable().default(null),
    link_text: z.string().nullable().default(null),
  })
  .strict();

// Proposed child action. Discriminated by proposal_type; the applier validates
// each against the canonical Knowledge proposal payload before creating a child.
export const RelationDiscoveryProposedActionSchema = z.union([
  z
    .object({
      proposal_type: z.literal("object_relation_create"),
      from_object_id: IdSchema,
      to_object_id: IdSchema,
      link_type: z.string(),
      confidence: z.number().min(0).max(1),
      evidence_summary: z.string(),
    })
    .strict(),
  z
    .object({
      proposal_type: z.literal("knowledge_create"),
      title: z.string(),
      knowledge_kind: z.string(),
      content: z.string(),
      content_format: z.string(),
      visibility: z.string(),
    })
    .strict(),
]);

export const RelationDiscoveryCandidateSchema = z
  .object({
    id: IdSchema,
    kind: RelationDiscoveryCandidateKindSchema,
    cluster_key: z.string(),
    title: z.string(),
    reason: z.string(),
    confidence_tier: ConfidenceTierSchema,
    evidence_refs: z.array(EvidenceRefSchema).default([]),
    markers: z.record(z.unknown()).default({}),
    proposed_action: RelationDiscoveryProposedActionSchema.nullable().default(null),
  })
  .strict();
export type RelationDiscoveryCandidate = z.infer<typeof RelationDiscoveryCandidateSchema>;

export const RelationDiscoveryReportSchema = z
  .object({
    candidates: z.array(RelationDiscoveryCandidateSchema).default([]),
    counts: z.record(z.number()).default({}),
    sources_scanned: z.number().int().nonnegative().default(0),
    links_extracted: z.number().int().nonnegative().default(0),
    truncated: z.boolean().default(false),
    access_safety: z
      .object({
        only_visible_source_text: z.literal(true),
        only_visible_targets: z.literal(true),
        deterministic_extraction: z.literal(true),
        source_policy_enforced: z.literal(true),
        llm_extraction_requested: z.boolean().default(false),
        llm_extraction_used: z.boolean().default(false),
        canonical_write_performed: z.literal(false),
      })
      .strict(),
    llm_extraction: z.record(z.unknown()).default({}),
  })
  .strict();
export type RelationDiscoveryReport = z.infer<typeof RelationDiscoveryReportSchema>;

export const RelationDiscoveryScanResponseSchema = z
  .object({
    generated_at: ISODateTimeSchema,
    space_id: IdSchema,
    report: RelationDiscoveryReportSchema,
    artifact_id: IdSchema.optional(),
    proposal_id: IdSchema.optional(),
    candidate_count: z.number().int().nonnegative().default(0),
    proposal_candidate_count: z.number().int().nonnegative().default(0),
    review_only_candidate_count: z.number().int().nonnegative().default(0),
    canonical_write_performed: z.literal(false),
    ...SecretResponseGuards,
  })
  .strict();
export type RelationDiscoveryScanResponse = z.infer<typeof RelationDiscoveryScanResponseSchema>;

export const RELATION_DISCOVERY_REPORT_ARTIFACT_TYPE = "relation_discovery_report";
export const RELATION_DISCOVERY_PACKET_PROPOSAL_TYPE = "relation_discovery_packet";
