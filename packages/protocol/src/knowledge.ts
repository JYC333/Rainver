/**
 * Knowledge-domain wire contracts.
 *
 * These schemas cover the global Claim / ClaimSource / ClaimRelation /
 * ObjectRelation API shapes plus the structured proposal packets a managed run
 * may emit. The protocol package owns schemas only; server modules own route
 * authority and durable mutation.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

const JsonObjectSchema = z.record(z.unknown());
const DateLikeSchema = ISODateTimeSchema.nullish();

export const CLAIM_KIND_VALUES = [
  "fact",
  "hypothesis",
  "belief",
  "preference",
  "commitment",
  "question",
  "interpretation",
  "instruction",
  "metric",
  "relationship",
  "event",
] as const;
export const CLAIM_STATUS_VALUES = [
  "active",
  "disputed",
  "superseded",
  "rejected",
  "archived",
] as const;
export const CLAIM_CONFIDENCE_METHOD_VALUES = [
  "human_confirmed",
  "source_extracted",
  "llm_extracted",
  "inferred",
  "imported",
] as const;
export const CLAIM_RESOLUTION_STATE_VALUES = [
  "unreviewed",
  "confirmed",
  "contradicted",
  "stale",
  "needs_source",
] as const;
export const CLAIM_EVIDENCE_ROLE_VALUES = [
  "supports",
  "contradicts",
  "mentions",
  "derived_from",
  "cites",
  "summarizes",
] as const;
export const CLAIM_SOURCE_REF_TYPE_VALUES = [
  "activity",
  "artifact",
  "run_event",
  "extracted_evidence",
  "source_snapshot",
  "external_pointer",
  "source_item",
] as const;
export const CLAIM_SOURCE_TRUST_VALUES = [
  "trusted",
  "normal",
  "untrusted",
  "unknown",
] as const;
export const CLAIM_RELATION_TYPE_VALUES = [
  "supports",
  "contradicts",
  "supersedes",
  "refines",
  "same_as",
  "depends_on",
  "derived_from",
] as const;
export const OBJECT_RELATION_TYPE_VALUES = [
  "related_to",
  "references",
  "depends_on",
  "part_of",
  "source_for",
  "derived_from",
  "about",
  "supports",
  "contradicts",
  "supersedes",
  "refines",
  "same_as",
] as const;
export const OBJECT_RELATION_STATUS_VALUES = [
  "candidate",
  "active",
  "rejected",
  "archived",
] as const;

const ClaimKindSchema = z.enum(CLAIM_KIND_VALUES);
const ClaimStatusSchema = z.enum(CLAIM_STATUS_VALUES);
const ClaimCreateStatusSchema = z.enum(["active", "disputed", "rejected"]);
const ClaimConfidenceMethodSchema = z.enum(CLAIM_CONFIDENCE_METHOD_VALUES);
const ClaimResolutionStateSchema = z.enum(CLAIM_RESOLUTION_STATE_VALUES);
const ClaimEvidenceRoleSchema = z.enum(CLAIM_EVIDENCE_ROLE_VALUES);
const ClaimSourceRefTypeSchema = z.enum(CLAIM_SOURCE_REF_TYPE_VALUES);
const ClaimSourceTrustSchema = z.enum(CLAIM_SOURCE_TRUST_VALUES);
const ObjectRelationTypeSchema = z.enum(OBJECT_RELATION_TYPE_VALUES);
const ObjectRelationStatusSchema = z.enum(OBJECT_RELATION_STATUS_VALUES);
const RelationCreateStatusSchema = z.enum(["candidate", "active"]);

const ConfidenceSchema = z.number().min(0).max(1).nullable();

export const ClaimSourceOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    claim_id: IdSchema,
    source_object_id: IdSchema.nullish(),
    source_ref_type: z.string().nullish(),
    source_ref_id: IdSchema.nullish(),
    source_connection_id: IdSchema.nullish(),
    source_policy_snapshot: JsonObjectSchema,
    locator: z.string().nullish(),
    quote_excerpt: z.string().nullish(),
    evidence_role: z.string(),
    source_trust: z.string().nullish(),
    confidence: ConfidenceSchema,
    metadata: JsonObjectSchema,
    created_by_user_id: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type ClaimSourceOut = z.infer<typeof ClaimSourceOutSchema>;

export const ClaimSummaryOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    subject_object_id: IdSchema.nullish(),
    subject_text: z.string().nullish(),
    claim_kind: z.string(),
    claim_text: z.string(),
    normalized_claim_hash: z.string(),
    confidence: ConfidenceSchema,
    confidence_method: z.string(),
    resolution_state: z.string(),
    status: ClaimStatusSchema,
    visibility: z.string(),
    title: z.string(),
    excerpt: z.string().nullish(),
    primary_project_id: IdSchema.nullish(),
    project_folder_id: IdSchema.nullish(),
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type ClaimSummaryOut = z.infer<typeof ClaimSummaryOutSchema>;

export const ClaimOutSchema = ClaimSummaryOutSchema.extend({
  holder_object_id: IdSchema.nullish(),
  holder_type: z.string().nullish(),
  holder_id: IdSchema.nullish(),
  valid_from: DateLikeSchema,
  valid_until: DateLikeSchema,
  observed_at: DateLikeSchema,
  metadata: JsonObjectSchema,
  sources: z.array(ClaimSourceOutSchema).default([]),
  owner_user_id: IdSchema.nullish(),
  created_by_user_id: IdSchema.nullish(),
  created_by_agent_id: IdSchema.nullish(),
  created_by_run_id: IdSchema.nullish(),
  created_from_proposal_id: IdSchema.nullish(),
  approved_by_user_id: IdSchema.nullish(),
  created_at: ISODateTimeSchema.nullish(),
  archived_at: DateLikeSchema,
}).passthrough();
export type ClaimOut = z.infer<typeof ClaimOutSchema>;

export const ClaimRelationOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    from_claim_id: IdSchema,
    to_claim_id: IdSchema,
    relation_type: z.string(),
    status: ObjectRelationStatusSchema,
    confidence: ConfidenceSchema,
    evidence_summary: z.string().nullish(),
    source_proposal_id: IdSchema.nullish(),
    created_by_user_id: IdSchema.nullish(),
    created_by_agent_id: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type ClaimRelationOut = z.infer<typeof ClaimRelationOutSchema>;

export const ObjectRelationOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    from_object_id: IdSchema,
    to_object_id: IdSchema,
    relation_type: z.string(),
    status: ObjectRelationStatusSchema,
    confidence: ConfidenceSchema,
    evidence_summary: z.string().nullish(),
    source_claim_id: IdSchema.nullish(),
    source_object_id: IdSchema.nullish(),
    source_proposal_id: IdSchema.nullish(),
    retrieval_projected: z.boolean(),
    metadata: JsonObjectSchema,
    created_by_user_id: IdSchema.nullish(),
    created_by_agent_id: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type ObjectRelationOut = z.infer<typeof ObjectRelationOutSchema>;

const PacketSystemFieldsSchema = z.object({
  source_run_id: IdSchema.optional(),
  created_by_run_id: IdSchema.optional(),
  proposal_type: z.string().optional(),
  project_id: IdSchema.nullish(),
  project_folder_id: IdSchema.nullish(),
});

const ClaimSourcePacketSchema = z
  .object({
    source_object_id: IdSchema.optional(),
    source_ref_type: ClaimSourceRefTypeSchema.optional(),
    source_ref_id: IdSchema.optional(),
    source_connection_id: IdSchema.optional(),
    source_policy_snapshot: JsonObjectSchema.optional(),
    source_policy_snapshot_json: JsonObjectSchema.optional(),
    locator: z.string().optional(),
    quote_excerpt: z.string().optional(),
    evidence_role: ClaimEvidenceRoleSchema.default("supports"),
    source_trust: ClaimSourceTrustSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if ((source.source_ref_type && !source.source_ref_id) || (!source.source_ref_type && source.source_ref_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_ref_type and source_ref_id must be provided together",
        path: ["source_ref_id"],
      });
    }
    if ((source.source_ref_type || source.source_ref_id) && !source.source_connection_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_ref entries require source_connection_id",
        path: ["source_connection_id"],
      });
    }
    if (!source.source_object_id && !source.source_connection_id && !source.source_ref_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "claim source requires source_object_id, source_connection_id, or source_ref_type/sources_ref_id",
      });
    }
  });
export type ClaimSourcePacket = z.infer<typeof ClaimSourcePacketSchema>;

export const ClaimCreateProposalPayloadSchema = PacketSystemFieldsSchema.extend({
  operation: z.literal("claim_create"),
  subject_object_id: IdSchema.optional(),
  subject_text: z.string().optional(),
  claim_kind: ClaimKindSchema,
  claim_text: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  normalized_claim_hash: z.string().optional(),
  holder_object_id: IdSchema.optional(),
  holder_type: z.string().optional(),
  holder_id: IdSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  confidence_method: ClaimConfidenceMethodSchema.optional(),
  status: ClaimCreateStatusSchema.optional(),
  resolution_state: ClaimResolutionStateSchema.optional(),
  valid_from: ISODateTimeSchema.optional(),
  valid_until: ISODateTimeSchema.optional(),
  observed_at: ISODateTimeSchema.optional(),
  visibility: z.string().optional(),
  owner_user_id: IdSchema.optional(),
  metadata: JsonObjectSchema.optional(),
  sources: z.array(ClaimSourcePacketSchema).optional(),
})
  .strict()
  .superRefine((payload, ctx) => {
    if (!payload.subject_object_id && !payload.subject_text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "claim subject_object_id or subject_text is required",
        path: ["subject_text"],
      });
    }
    const status = payload.status ?? "active";
    const resolutionState = payload.resolution_state ?? "unreviewed";
    if (status === "disputed" && resolutionState !== "contradicted" && resolutionState !== "needs_source") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "disputed Claims require resolution_state contradicted or needs_source",
        path: ["resolution_state"],
      });
    }
    if (status === "active" && resolutionState === "contradicted") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "active Claims cannot use resolution_state contradicted",
        path: ["resolution_state"],
      });
    }
  });

export const ClaimUpdateProposalPayloadSchema = PacketSystemFieldsSchema.extend({
  operation: z.literal("claim_update"),
  target_claim_id: IdSchema,
  subject_object_id: IdSchema.nullish(),
  subject_text: z.string().nullish(),
  claim_kind: ClaimKindSchema.optional(),
  claim_text: z.string().min(1).optional(),
  title: z.string().optional(),
  summary: z.string().nullish(),
  normalized_claim_hash: z.string().optional(),
  holder_object_id: IdSchema.nullish(),
  holder_type: z.string().nullish(),
  holder_id: IdSchema.nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  confidence_method: ClaimConfidenceMethodSchema.optional(),
  status: ClaimStatusSchema.optional(),
  resolution_state: ClaimResolutionStateSchema.optional(),
  superseded_by_claim_id: IdSchema.optional(),
  valid_from: ISODateTimeSchema.nullish(),
  valid_until: ISODateTimeSchema.nullish(),
  observed_at: ISODateTimeSchema.nullish(),
  visibility: z.string().optional(),
  metadata: JsonObjectSchema.optional(),
  sources: z.array(ClaimSourcePacketSchema).optional(),
}).strict();

export const ClaimArchiveProposalPayloadSchema = PacketSystemFieldsSchema.extend({
  operation: z.literal("claim_archive"),
  target_claim_id: IdSchema,
  proposed_content: z.string().optional(),
}).strict();

export const ObjectRelationCreateProposalPayloadSchema = PacketSystemFieldsSchema.extend({
  operation: z.literal("object_relation_create"),
  from_object_id: IdSchema,
  to_object_id: IdSchema,
  relation_type: ObjectRelationTypeSchema,
  status: RelationCreateStatusSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence_summary: z.string().optional(),
  source_claim_id: IdSchema.optional(),
  source_object_id: IdSchema.optional(),
  metadata: JsonObjectSchema.optional(),
}).strict();

export const ObjectRelationDeleteProposalPayloadSchema = PacketSystemFieldsSchema.extend({
  operation: z.literal("object_relation_delete"),
  relation_id: IdSchema,
}).strict();

export const ClaimObjectProposalPayloadSchema = z.union([
  ClaimCreateProposalPayloadSchema,
  ClaimUpdateProposalPayloadSchema,
  ClaimArchiveProposalPayloadSchema,
  ObjectRelationCreateProposalPayloadSchema,
  ObjectRelationDeleteProposalPayloadSchema,
]);
export type ClaimObjectProposalPayload = z.infer<typeof ClaimObjectProposalPayloadSchema>;

export const ClaimCandidatePacketCreateRequestSchema = z
  .object({
    source_artifact_ids: z.array(IdSchema).min(1).max(12),
    max_candidates: z.number().int().positive().max(100).default(40),
    review_scope: z.enum(["private", "space_ops"]).default("private"),
    promote_private_sources_to_space_ops: z.boolean().default(false),
    private_source_promotion_confirmed: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.promote_private_sources_to_space_ops) return;
    if (value.review_scope !== "space_ops") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["review_scope"],
        message: "private source promotion is only valid for space_ops review",
      });
    }
    if (value.private_source_promotion_confirmed !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["private_source_promotion_confirmed"],
        message: "private source promotion requires explicit confirmation",
      });
    }
  });
export type ClaimCandidatePacketCreateRequest = z.infer<
  typeof ClaimCandidatePacketCreateRequestSchema
>;

export const ClaimCandidatePacketCreateResponseSchema = z
  .object({
    artifact_id: IdSchema,
    proposal_id: IdSchema,
    candidate_count: z.number().int().nonnegative(),
    source_artifact_count: z.number().int().nonnegative(),
    generated_child_proposal_count: z.number().int().nonnegative(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ClaimCandidatePacketCreateResponse = z.infer<
  typeof ClaimCandidatePacketCreateResponseSchema
>;
