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

// Actions only, ordered by stage. `pause` and `wait_for_monitoring` were
// states wearing an action's clothing and were removed with the step model:
// pausing is an `attention_state` change, and waiting on monitoring is what a
// running background step already means.
export const InquiryNextFocusKindSchema = z.enum([
  "clarify_or_decompose",
  "search_acquisition",
  "design_run_experiment",
  "read_evidence",
  "synthesize",
  "promote_knowledge",
  "create_decision_case",
  "create_delivery_task",
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

// One attempt at advancing a Thread. `slot` is what keeps human attention
// singular: `background` steps run without a person and leave the `primary`
// slot free for whatever the user does meanwhile.
export const InquiryThreadStepSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  thread_id: z.string(),
  kind: InquiryNextFocusKindSchema,
  status: z.enum(["in_progress", "done", "abandoned"]),
  slot: z.enum(["primary", "background"]),
  note: z.string().nullable(),
  target_ref_kind: z.string().nullable(),
  target_ref_id: z.string().nullable(),
  iteration_id: z.string().nullable(),
  origin: z.enum(["user", "advice", "system"]),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
});
export type InquiryThreadStep = z.infer<typeof InquiryThreadStepSchema>;

/** An open Step with the Thread it belongs to, for the cross-Area origin bar. */
export const InquiryOpenStepSchema = InquiryThreadStepSchema.extend({
  statement: z.string(),
});
export type InquiryOpenStep = z.infer<typeof InquiryOpenStepSchema>;

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

export const InquiryDeltaPositionChangeSchema = z.object({
  thread_id: z.string(),
  statement: z.string(),
  count: z.number().int().nonnegative(),
});
export type InquiryDeltaPositionChange = z.infer<typeof InquiryDeltaPositionChangeSchema>;

export const InquiryDeltaGapChangeSchema = z.object({
  thread_id: z.string(),
  statement: z.string(),
  new_gaps: z.number().int().nonnegative(),
  filled_gaps: z.number().int().nonnegative(),
});
export type InquiryDeltaGapChange = z.infer<typeof InquiryDeltaGapChangeSchema>;

export const InquiryDeltaBriefContentSchema = z.object({
  schema_version: z.literal("inquiry_delta_brief.v1"),
  input_and_coverage_window: z.object({
    coverage_start: z.string().nullable(),
    coverage_end: z.string(),
    signal_count: z.number().int().nonnegative(),
  }),
  reinforced_positions: z.array(InquiryDeltaPositionChangeSchema),
  challenged_positions: z.array(InquiryDeltaPositionChangeSchema),
  gap_changes: z.array(InquiryDeltaGapChangeSchema),
  decisions_required: z.number().int().nonnegative(),
  no_change_statement: z.string().nullable(),
  source_and_thread_refs: z.array(z.object({
    signal_id: z.string(),
    thread_id: z.string(),
    corpus_item_id: z.string().nullable(),
  })),
});
export type InquiryDeltaBriefContent = z.infer<typeof InquiryDeltaBriefContentSchema>;

export const InquiryAdviceStatusSchema = z.enum(["open", "adopted", "dismissed"]);

/**
 * A model-generated suggestion about a Thread's next step. It is never a
 * write: adopting it goes through the ordinary work-state command. `stale`
 * means the Thread has moved past the revision the advice reasoned about.
 */
export const InquiryThreadAdviceSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  thread_id: z.string(),
  recommended_focus_kind: InquiryNextFocusKindSchema,
  rationale: z.string(),
  cited_refs: z.array(z.string()),
  thread_version: z.number().int(),
  status: InquiryAdviceStatusSchema,
  trigger_kind: z.string(),
  model_version: z.string().nullable(),
  stale: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type InquiryThreadAdvice = z.infer<typeof InquiryThreadAdviceSchema>;

export const InquiryCreateSignalRequestSchema = z.object({
  corpus_item_id: z.string().min(1),
  classification: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable().optional(),
  model_version: z.string().nullable().optional(),
  source_provenance: z.record(z.unknown()).optional(),
  producer_idempotency_key: z.string().nullable().optional(),
  proposed_change: z.record(z.unknown()).optional(),
});

export const InquiryCandidateDecisionRequestSchema = z.object({
  decision: InquiryCandidateDecisionSchema,
  edits: z.record(z.unknown()).optional(),
  change_summary: z.string().optional(),
  target_candidate_id: z.string().optional(),
  reason: z.string().optional(),
  defer_until: z.string().optional(),
  gap_statement: z.string().optional(),
});

export const InquiryLifecycleTransitionRequestSchema = z.object({
  lifecycle_status: z.enum(["active", "resolved", "rejected", "archived"]),
  reason: z.string().nullable().optional(),
});
