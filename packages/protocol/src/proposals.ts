/**
 * Proposal review contracts.
 *
 * These schemas describe the wire DTOs for the proposal review API. Schemas
 * only: route ownership and persistence authority live in the services that
 * register the routes.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

const JsonObjectSchema = z.record(z.unknown());

export const ProposalOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    user_id: z.string(),
    project_folder_id: IdSchema.nullish(),
    source_session_id: IdSchema.nullish(),
    source_task_id: IdSchema.nullish(),
    source_run_id: IdSchema.nullish(),
    created_by_run_id: IdSchema.nullish(),
    proposal_type: z.string(),
    target_scope: z.string(),
    target_namespace: z.string(),
    memory_type: z.string(),
    proposed_title: z.string(),
    proposed_content: z.string(),
    rationale: z.string(),
    status: z.string(),
    risk_level: z.string(),
    urgency: z.string(),
    visibility: z.string(),
    preview: z.boolean(),
    review_deadline: ISODateTimeSchema.nullish(),
    expires_at: ISODateTimeSchema.nullish(),
    expired: z.boolean(),
    created_at: ISODateTimeSchema,
    decided_at: ISODateTimeSchema.nullish(),
    resulting_memory_id: IdSchema.nullish(),
    owner_user_id: IdSchema.nullish(),
    subject_user_id: IdSchema.nullish(),
    sensitivity_level: z.string().nullish(),
    access_level: z.string().nullish(),
    provenance_entries: z.array(JsonObjectSchema).nullish(),
    source_activity_id: IdSchema.nullish(),
    grant_id: IdSchema.nullish(),
    required_approver_user_id: IdSchema.nullish(),
    required_approver_user_ids: z.array(IdSchema).nullish(),
    requires_approval_type: z.string().nullish(),
    egress_approval_status: z.string().nullish(),
    egress_approval_id: IdSchema.nullish(),
    project_id: IdSchema.nullish(),
    incomplete_patch: z.boolean().optional(),
    skipped_changes: z.array(JsonObjectSchema).optional(),
    skipped_count: z.number().int().nonnegative().optional(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ProposalOut = z.infer<typeof ProposalOutSchema>;

export const ProposalPageSchema = z
  .object({
    items: z.array(ProposalOutSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ProposalPage = z.infer<typeof ProposalPageSchema>;

export const ProposalAcceptResultTypeSchema = z.enum([
  "memory_entry",
  "code_patch_apply",
  "policy_version",
  "egress_review",
  "follow_up_task",
  "agent_version",
  "capability_overlay",
  "knowledge_item",
  "claim",
  "object_relation",
  "object_profile",
  "claim_candidate_packet",
  "memory_maintenance_packet",
  "retrieval_maintenance_packet",
  "retrieval_diagnostics_packet",
  "relation_discovery_packet",
  "custom_source_handler_version",
  "source_recipe_version",
  "source_connection",
  "source_channel",
  "project_source_binding",
  "source_backfill_plan",
  "research_query_strategy",
  "evolvable_asset_version",
  "evolution_bundle_rollback",
  "plan_version",
  "plan_checkpoint",
  "workflow_execution_checkpoint",
  "project_brief_version",
  "project_operation",
]);
export type ProposalAcceptResultType = z.infer<
  typeof ProposalAcceptResultTypeSchema
>;

/**
 * Applier results are per-applier shapes, so `result` is an open object for
 * every type except the three whose fields consumers actually read. Those are
 * declared from what the owning applier returns: `code_patch_apply` from the
 * Project Folder patch applier, and the two review packets from the shared
 * packet applier, which reports the child proposals it generated and, when it
 * skipped any, how many.
 */
export const ProposalAcceptCodePatchResultSchema = z
  .object({
    updated_paths: z.array(z.string()),
    code_patch_files: z.array(JsonObjectSchema).optional(),
  })
  .passthrough();

export const ProposalAcceptReviewPacketResultSchema = z
  .object({
    generated_child_proposal_ids: z.array(IdSchema),
    generated_child_proposal_count: z.number().int().nonnegative(),
    skipped_child_proposal_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const ProposalAcceptBaseShape = {
  proposal: ProposalOutSchema,
  ...SecretResponseGuards,
};

export const ProposalAcceptOutSchema = z.union([
  z
    .object({
      ...ProposalAcceptBaseShape,
      result_type: z.literal("code_patch_apply"),
      result: ProposalAcceptCodePatchResultSchema,
    })
    .passthrough(),
  z
    .object({
      ...ProposalAcceptBaseShape,
      result_type: z.enum(["retrieval_maintenance_packet", "claim_candidate_packet"]),
      result: ProposalAcceptReviewPacketResultSchema,
    })
    .passthrough(),
  z
    .object({
      ...ProposalAcceptBaseShape,
      // Excluded so the three typed members above can discriminate: a
      // union whose fallback also accepts their literals narrows to nothing.
      result_type: ProposalAcceptResultTypeSchema.exclude([
        "code_patch_apply",
        "retrieval_maintenance_packet",
        "claim_candidate_packet",
      ]),
      result: JsonObjectSchema,
    })
    .passthrough(),
]);
export type ProposalAcceptOut = z.infer<typeof ProposalAcceptOutSchema>;

export const ProposalApprovalOutSchema = z
  .object({
    id: IdSchema,
    proposal_id: IdSchema,
    approval_type: z.string(),
    approver_user_id: IdSchema,
    grant_id: IdSchema.nullish(),
    target_space_id: IdSchema.nullish(),
    status: z.string(),
    metadata_json: JsonObjectSchema.nullish(),
    created_at: ISODateTimeSchema,
    revoked_at: ISODateTimeSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ProposalApprovalOut = z.infer<typeof ProposalApprovalOutSchema>;

export const ProposalAcceptDispatchRequestSchema = z.object({
  proposal_id: IdSchema,
  space_id: IdSchema,
  user_id: IdSchema,
  confirm_incomplete_patch: z.boolean().default(false),
});

export const ProposalRejectDispatchRequestSchema = z.object({
  proposal_id: IdSchema,
  space_id: IdSchema,
  user_id: IdSchema,
});

export const ProposalEgressApprovalDispatchRequestSchema = z.object({
  proposal_id: IdSchema,
  space_id: IdSchema,
  user_id: IdSchema,
  grant_id: IdSchema.nullish(),
});
