import { z } from "zod";

export const InquiryThreadKindSchema = z.enum(["question", "hypothesis"]);
export type InquiryThreadKind = z.infer<typeof InquiryThreadKindSchema>;

export const InquiryLifecycleStatusSchema = z.enum([
  "active",
  "resolved",
  "rejected",
  "archived",
  "superseded",
]);
export type InquiryLifecycleStatus = z.infer<typeof InquiryLifecycleStatusSchema>;

export const InquiryAttentionStateSchema = z.enum([
  "focused",
  "monitoring",
  "backlog",
  "blocked",
  "resolved",
  "rejected",
  "archived",
]);
export type InquiryAttentionState = z.infer<typeof InquiryAttentionStateSchema>;

export const InquiryNextFocusKindSchema = z.enum([
  "search_acquisition",
  "read_evidence",
  "synthesize",
  "clarify_or_decompose",
  "design_run_experiment",
  "create_decision_case",
  "create_delivery_task",
  "wait_for_monitoring",
  "promote_knowledge",
  "pause",
]);
export type InquiryNextFocusKind = z.infer<typeof InquiryNextFocusKindSchema>;

export const InquiryThreadSchema = z.object({
  id: z.string(),
  space_id: z.string(),
  project_id: z.string(),
  kind: InquiryThreadKindSchema,
  statement: z.string(),
  lifecycle_status: InquiryLifecycleStatusSchema,
  attention_state: InquiryAttentionStateSchema,
  priority: z.number().int(),
  primary_parent_id: z.string().nullable(),
  owner_user_id: z.string().nullable(),
  next_focus_kind: InquiryNextFocusKindSchema.nullable(),
  next_focus_note: z.string().nullable(),
  blocked_reason: z.string().nullable(),
  version: z.number().int(),
  created_from: z.string(),
  created_by_user_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type InquiryThread = z.infer<typeof InquiryThreadSchema>;

export const InquiryIterationSchema = z.object({
  id: z.string(),
  space_id: z.string(),
  project_id: z.string(),
  thread_id: z.string(),
  trigger_kind: z.string(),
  trigger_ref: z.string().nullable(),
  input_refs_json: z.array(z.unknown()),
  previous_position_json: z.record(z.unknown()),
  new_position_json: z.record(z.unknown()),
  confidence_delta: z.number().nullable(),
  change_summary: z.string(),
  reasoning_summary: z.string().nullable(),
  unresolved_gaps: z.string().nullable(),
  confirmed_next_focus: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  created_by_run_id: z.string().nullable(),
  created_at: z.string(),
});
export type InquiryIteration = z.infer<typeof InquiryIterationSchema>;

export const InquiryCandidateDecisionSchema = z.enum(["accept", "merge", "defer", "dismiss", "gap"]);
export type InquiryCandidateDecision = z.infer<typeof InquiryCandidateDecisionSchema>;

export const InquiryEvidenceSignalSchema = z.object({
  id: z.string(),
  space_id: z.string(),
  project_id: z.string(),
  thread_id: z.string(),
  corpus_item_id: z.string(),
  classification: z.string(),
  is_material: z.boolean(),
  confidence: z.number().nullable(),
  model_version: z.string().nullable(),
  source_provenance: z.record(z.unknown()),
  dedupe_key: z.string(),
  producer_idempotency_key: z.string().nullable(),
  status: z.string(),
  candidate_id: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  created_by_run_id: z.string().nullable(),
  created_at: z.string(),
});
export type InquiryEvidenceSignal = z.infer<typeof InquiryEvidenceSignalSchema>;

export const InquiryCandidateStatusSchema = z.enum([
  "pending",
  "accepted",
  "merged",
  "deferred",
  "dismissed",
  "gap",
]);
export type InquiryCandidateStatus = z.infer<typeof InquiryCandidateStatusSchema>;

export const InquiryCandidateSchema = z.object({
  id: z.string(),
  space_id: z.string(),
  project_id: z.string(),
  thread_id: z.string(),
  candidate_kind: z.string(),
  semantic_key: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  proposed_change: z.record(z.unknown()),
  status: InquiryCandidateStatusSchema,
  review_packet_id: z.string().nullable(),
  resulting_iteration_id: z.string().nullable(),
  resulting_thread_id: z.string().nullable(),
  merged_into_candidate_id: z.string().nullable(),
  decision_reason: z.string().nullable(),
  defer_until: z.string().nullable(),
  decided_by_user_id: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  signals: z.array(InquiryEvidenceSignalSchema).optional(),
});
export type InquiryCandidate = z.infer<typeof InquiryCandidateSchema>;

export const InquiryReviewPacketSchema = z.object({
  id: z.string().nullable(),
  project_id: z.string(),
  status: z.enum(["open", "closed", "empty"]),
  created_at: z.string(),
  candidates: z.array(InquiryCandidateSchema),
});
export type InquiryReviewPacket = z.infer<typeof InquiryReviewPacketSchema>;

export const InquiryDeltaBriefContentSchema = z.object({
  schema_version: z.literal("inquiry_delta_brief.v1"),
  input_and_coverage_window: z.object({
    coverage_start: z.string().nullable(),
    coverage_end: z.string(),
    signal_count: z.number().int().nonnegative(),
  }),
  reinforced_positions: z.array(z.unknown()),
  challenged_positions: z.array(z.unknown()),
  gap_changes: z.array(z.unknown()),
  decisions_required: z.number().int().nonnegative(),
  no_change_statement: z.string().nullable(),
  source_and_thread_refs: z.array(z.unknown()),
});
export type InquiryDeltaBriefContent = z.infer<typeof InquiryDeltaBriefContentSchema>;

export const InquiryCreateSignalRequestSchema = z.object({
  corpus_item_id: z.string().min(1),
  classification: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable().optional(),
  model_version: z.string().nullable().optional(),
  source_provenance: z.record(z.unknown()).optional(),
  producer_idempotency_key: z.string().nullable().optional(),
  proposed_change: z.record(z.unknown()).optional(),
});
export type InquiryCreateSignalRequest = z.infer<typeof InquiryCreateSignalRequestSchema>;

export const InquiryCandidateDecisionRequestSchema = z.object({
  decision: InquiryCandidateDecisionSchema,
  edits: z.record(z.unknown()).optional(),
  change_summary: z.string().optional(),
  target_candidate_id: z.string().optional(),
  reason: z.string().optional(),
  defer_until: z.string().optional(),
  gap_statement: z.string().optional(),
});
export type InquiryCandidateDecisionRequest = z.infer<typeof InquiryCandidateDecisionRequestSchema>;

export const InquiryLifecycleTransitionRequestSchema = z.object({
  lifecycle_status: z.enum(["active", "resolved", "rejected", "archived"]),
  reason: z.string().nullable().optional(),
});
export type InquiryLifecycleTransitionRequest = z.infer<typeof InquiryLifecycleTransitionRequestSchema>;
