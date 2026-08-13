import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

const JsonObjectSchema = z.record(z.unknown());
const RefSchema = z.object({
  type: z.string().trim().min(1).max(64),
  id: z.string().trim().min(1).max(256),
  version: z.string().trim().min(1).max(128).nullable().optional(),
}).strict();

export const RuntimeContextPolicyScopeSchema = z.enum([
  "space",
  "project",
  "project_folder",
  "agent",
  "user",
]);
export type RuntimeContextPolicyScope = z.infer<typeof RuntimeContextPolicyScopeSchema>;

export const RuntimeContextAcquisitionSchema = z.enum([
  "direct",
  "explicit",
  "retrieval",
  "continuity",
  "runtime_event",
]);
export type RuntimeContextAcquisition = z.infer<typeof RuntimeContextAcquisitionSchema>;

export const RuntimeContextSelectionSchema = z.enum(["required", "pinned", "ranked"]);
export type RuntimeContextSelection = z.infer<typeof RuntimeContextSelectionSchema>;

export const RuntimeContextSemanticRoleSchema = z.enum([
  "delegated_instruction",
  "user_input",
  "reference_data",
]);
export type RuntimeContextSemanticRole = z.infer<typeof RuntimeContextSemanticRoleSchema>;

export const RuntimeContextSensitivitySchema = z.enum([
  "normal",
  "sensitive",
  "restricted",
  "highly_restricted",
]);
export type RuntimeContextSensitivity = z.infer<typeof RuntimeContextSensitivitySchema>;

export const RuntimeContextTrustSchema = z.enum([
  "system_approved",
  "user_confirmed",
  "domain_approved",
  "derived",
  "external_untrusted",
]);
export type RuntimeContextTrust = z.infer<typeof RuntimeContextTrustSchema>;

export const RuntimeContextPolicyDocumentSchema = z.object({
  constraints: z.object({
    retrieval_domains: z.array(z.string().trim().min(1).max(64)).optional(),
    retrieval_max_candidates: z.number().int().nonnegative().max(10_000).optional(),
    memory_layers: z.array(z.string().trim().min(1).max(64)).optional(),
    explicit_reference_types: z.array(z.string().trim().min(1).max(64)).optional(),
    explicit_reference_max: z.number().int().nonnegative().max(1_000).optional(),
    explicit_reference_sensitivity_ceiling: RuntimeContextSensitivitySchema.optional(),
    pinned_reference_max: z.number().int().nonnegative().max(1_000).optional(),
    pinned_reference_types: z.array(z.string().trim().min(1).max(64)).optional(),
    continuity_modes: z.array(z.enum(["none", "recent", "checkpoint", "stateful_cli"])).optional(),
    allow_project_brief: z.boolean().optional(),
    allow_project_instructions: z.boolean().optional(),
    allow_sealed_payload: z.boolean().optional(),
    sealed_payload_retention_seconds: z.number().int().nonnegative().max(31_536_000).optional(),
  }).strict().default({}),
  preferences: z.object({
    retrieval_enabled: z.boolean().optional(),
    retrieval_mode: z.enum(["exact", "hybrid", "broad"]).optional(),
    include_project_brief: z.boolean().optional(),
    include_project_instructions: z.boolean().optional(),
    continuity_strategy: z.enum(["none", "recent", "checkpoint", "stateful_cli"]).optional(),
    output_reserve_tokens: z.number().int().nonnegative().optional(),
    compaction_trigger_tokens: z.number().int().positive().optional(),
  }).strict().default({}),
}).strict();
export type RuntimeContextPolicyDocument = z.infer<typeof RuntimeContextPolicyDocumentSchema>;

export const RuntimeContextPolicyVersionSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  scope_type: RuntimeContextPolicyScopeSchema,
  scope_id: IdSchema,
  version: z.number().int().positive(),
  policy: RuntimeContextPolicyDocumentSchema,
  base_version_id: IdSchema.nullable(),
  typed_diff: JsonObjectSchema,
  reason: z.string().max(2000).nullable(),
  created_by_user_id: IdSchema,
  created_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict().superRefine((version, context) => {
  if (version.scope_type === "space" && version.scope_id !== version.space_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Space policy scope_id must equal space_id",
      path: ["scope_id"],
    });
  }
});
export type RuntimeContextPolicyVersion = z.infer<typeof RuntimeContextPolicyVersionSchema>;

export const RuntimeContextResolvedPolicySchema = z.object({
  policy: RuntimeContextPolicyDocumentSchema,
  contributing_versions: z.array(RefSchema),
  resolution_hash: z.string().min(1),
}).strict();
export type RuntimeContextResolvedPolicy = z.infer<typeof RuntimeContextResolvedPolicySchema>;

export const RuntimeContextPolicyWriteRequestSchema = z.object({
  base_version_id: IdSchema.nullable(),
  policy: RuntimeContextPolicyDocumentSchema,
  reason: z.string().trim().min(1).max(2000),
}).strict();
export type RuntimeContextPolicyWriteRequest = z.infer<typeof RuntimeContextPolicyWriteRequestSchema>;

export const RuntimeContextPolicyResolveRequestSchema = z.object({
  project_id: IdSchema.nullable().optional(),
  project_folder_id: IdSchema.nullable().optional(),
  agent_id: IdSchema.nullable().optional(),
  include_user_policy: z.boolean().default(true),
}).strict();
export type RuntimeContextPolicyResolveRequest = z.infer<typeof RuntimeContextPolicyResolveRequestSchema>;

export const RuntimeContextPolicyVersionListResponseSchema = z.object({
  items: z.array(RuntimeContextPolicyVersionSchema),
}).strict();

export const RuntimeContextActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), user_id: IdSchema }).strict(),
  z.object({
    type: z.literal("agent"),
    agent_id: IdSchema,
    instructed_by_user_id: IdSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("automation"),
    automation_id: IdSchema,
    instructed_by_user_id: IdSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("connector"),
    connector_id: IdSchema,
    instructed_by_user_id: IdSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("service"),
    service_name: z.string().trim().min(1).max(128),
    instructed_by_user_id: IdSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("system"),
    service_name: z.string().trim().min(1).max(128).nullable(),
    instructed_by_user_id: IdSchema.nullable(),
  }).strict(),
]);

export const ExecutionReadableScopeSchema = z.object({
  space_id: IdSchema,
  allowed_source_types: z.array(z.string().trim().min(1).max(64)),
  unrestricted_source_categories: z.array(z.enum([
    "explicit_reference",
    "pinned_reference",
    "memory",
    "retrieval",
  ])),
  explicit_reference_types: z.array(z.string().trim().min(1).max(64)),
  explicit_reference_max: z.number().int().nonnegative().max(1_000).nullable(),
  pinned_reference_types: z.array(z.string().trim().min(1).max(64)),
  pinned_reference_max: z.number().int().nonnegative().max(1_000).nullable(),
  retrieval_enabled: z.boolean(),
  retrieval_max_candidates: z.number().int().nonnegative().max(10_000).nullable(),
  explicit_reference_sensitivity_ceiling: RuntimeContextSensitivitySchema.nullable(),
  allowed_source_ids: z.array(RefSchema),
  excluded_source_ids: z.array(RefSchema),
  sensitivity_ceiling: RuntimeContextSensitivitySchema,
}).strict();

export const ExecutionEgressControlSchema = z.object({
  destination_type: z.enum(["local_runtime", "local_cli", "model_provider", "connector", "none"]),
  destination_id: IdSchema.nullable(),
  sensitivity_ceiling: RuntimeContextSensitivitySchema,
  external_egress_allowed: z.boolean(),
  allowed_provider_ids: z.array(IdSchema),
}).strict().superRefine((egress, context) => {
  if (egress.destination_type === "none"
    && (egress.destination_id !== null || egress.external_egress_allowed)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "No-egress destinations require a null destination and disabled external egress",
      path: ["destination_type"],
    });
  }
  if (egress.destination_type === "local_runtime" && egress.external_egress_allowed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Local runtime destinations cannot enable external egress",
      path: ["external_egress_allowed"],
    });
  }
  if (egress.destination_type === "local_cli"
    && (egress.destination_id === null || !egress.external_egress_allowed)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Local CLI destinations require an adapter id and enabled external egress",
      path: ["destination_type"],
    });
  }
  if (egress.destination_type === "model_provider" && egress.destination_id === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Model provider destinations require a provider id",
      path: ["destination_id"],
    });
  }
  if (egress.destination_type === "model_provider"
    && egress.external_egress_allowed
    && !egress.allowed_provider_ids.includes(egress.destination_id!)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Enabled provider egress requires the destination in allowed_provider_ids",
      path: ["allowed_provider_ids"],
    });
  }
  if (egress.destination_type === "connector"
    && (egress.destination_id === null || !egress.external_egress_allowed)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Connector destinations require an id and enabled external egress",
      path: ["destination_id"],
    });
  }
});

export const ExecutionPersistenceControlSchema = z.object({
  event_capture_allowed: z.boolean(),
  checkpoint_allowed: z.boolean(),
  memory_proposals_allowed: z.boolean(),
  sealed_payload_retention_seconds: z.number().int().nonnegative().max(31_536_000),
}).strict();

export const ExecutionOutputControlSchema = z.object({
  schema_ref: RefSchema.nullable(),
  unstructured_output_allowed: z.boolean(),
  max_output_tokens: z.number().int().nonnegative().nullable(),
}).strict();

export const ExecutionControlSnapshotSchema = z.object({
  id: IdSchema,
  version: z.literal(2),
  space_id: IdSchema,
  actor: RuntimeContextActorSchema,
  project_id: IdSchema.nullable(),
  project_folder_id: IdSchema.nullable(),
  agent_id: IdSchema.nullable(),
  work_context_scope_id: IdSchema.nullable(),
  work_context_setup_ref: RefSchema.nullable(),
  project_brief_ref: RefSchema.nullable(),
  project_instruction_ref: RefSchema.nullable(),
  readable_scope: ExecutionReadableScopeSchema,
  egress: ExecutionEgressControlSchema,
  tool_grant_refs: z.array(RefSchema),
  credential_channel_ref: RefSchema.nullable(),
  sandbox_profile_ref: RefSchema.nullable(),
  approval_refs: z.array(RefSchema),
  persistence: ExecutionPersistenceControlSchema,
  output_contract: ExecutionOutputControlSchema,
  governing_policy_version_refs: z.array(RefSchema).min(1),
  policy_decision_refs: z.array(RefSchema),
  created_at: ISODateTimeSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.readable_scope.space_id !== snapshot.space_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "readable_scope.space_id must match the snapshot space_id",
      path: ["readable_scope", "space_id"],
    });
  }
});
export type ExecutionControlSnapshot = z.infer<typeof ExecutionControlSnapshotSchema>;

export const WorkContextScopeKindSchema = z.enum([
  "direct_session",
  "room_recipient",
  "root_task",
  "workflow_execution",
]);

export const WorkRetrievalPreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["exact", "hybrid", "broad"]).optional(),
  max_candidates: z.number().int().nonnegative().max(10_000).optional(),
  preferred_domains: z.array(z.string().trim().min(1).max(64)).optional(),
}).strict();

export const WorkContinuityPreferencesSchema = z.object({
  strategy: z.enum(["none", "recent", "checkpoint", "stateful_cli"]).optional(),
  continue_vendor_session: z.boolean().optional(),
  isolate_sensitive_one_offs: z.boolean().optional(),
}).strict();

export const WorkContextSetupSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  work_context_scope_id: IdSchema,
  scope_kind: WorkContextScopeKindSchema,
  version: z.number().int().positive(),
  user_id: IdSchema,
  project_id: IdSchema.nullable(),
  project_folder_id: IdSchema.nullable(),
  agent_id: IdSchema.nullable(),
  runtime_ref: RefSchema.nullable(),
  pinned_refs: z.array(RefSchema),
  excluded_refs: z.array(RefSchema),
  retrieval_preferences: WorkRetrievalPreferencesSchema,
  continuity_preferences: WorkContinuityPreferencesSchema,
  project_brief_version_id: IdSchema.nullable(),
  project_instruction_version_id: IdSchema.nullable(),
  project_instruction_enabled: z.boolean(),
  governing_policy_refs: z.array(RefSchema),
  setup_fingerprint: z.string().min(1),
  base_version: z.number().int().positive().nullable(),
  typed_diff: JsonObjectSchema,
  reason: z.string().trim().min(1).max(512),
  policy_decision_ref: RefSchema,
  created_by_user_id: IdSchema,
  created_at: ISODateTimeSchema,
}).strict();

export const WorkContextSetupWriteRequestSchema = WorkContextSetupSchema.pick({
  work_context_scope_id: true,
  scope_kind: true,
  project_id: true,
  project_folder_id: true,
  agent_id: true,
  runtime_ref: true,
  pinned_refs: true,
  excluded_refs: true,
  retrieval_preferences: true,
  continuity_preferences: true,
}).extend({
  base_version: z.number().int().positive().nullable(),
  reason: z.string().trim().min(1).max(512),
}).strict();
export type WorkContextSetupWriteRequest = z.infer<typeof WorkContextSetupWriteRequestSchema>;

/**
 * `retrieval_intent` is a search query, not the turn's instruction. Producers
 * bound their value with this constant so a long prompt is truncated into a
 * query instead of failing the whole run on schema validation.
 */
export const RETRIEVAL_INTENT_MAX_CHARS = 4_000;

export const TurnContextRequestSchema = z.object({
  work_context_scope_id: IdSchema,
  expected_setup_version: z.number().int().positive(),
  current_message_ref: RefSchema,
  one_off_refs: z.array(RefSchema).max(1_000).default([]),
  retrieval_intent: z.string().trim().max(RETRIEVAL_INTENT_MAX_CHARS).nullable().optional(),
  invocation_purpose: z.string().trim().min(1).max(128),
}).strict();
export type TurnContextRequest = z.infer<typeof TurnContextRequestSchema>;

export const ContextItemSchema = z.object({
  id: z.string().min(1),
  source_ref: RefSchema,
  acquisition: RuntimeContextAcquisitionSchema,
  selection: RuntimeContextSelectionSchema,
  rank: z.number().int().positive().nullable(),
  score: z.number().finite().nullable(),
  semantic_role: RuntimeContextSemanticRoleSchema,
  trust: RuntimeContextTrustSchema,
  sensitivity: RuntimeContextSensitivitySchema,
  visibility: z.enum(["private", "space_shared", "selected_users"]),
  owner_user_id: IdSchema.nullable(),
  space_id: IdSchema,
  egress_eligible: z.boolean(),
  token_estimate: z.number().int().nonnegative(),
  payload: JsonObjectSchema,
  revalidation: JsonObjectSchema,
  conflict_key: z.string().nullable().optional(),
}).strict().superRefine((item, context) => {
  if (item.acquisition === "retrieval" && item.semantic_role !== "reference_data") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Retrieval-produced context must remain reference_data",
      path: ["semantic_role"],
    });
  }
  if (item.acquisition === "retrieval" && (item.selection !== "ranked" || item.rank === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Retrieval-produced context must remain ranked with a valid rank",
      path: ["selection"],
    });
  }
  if ((item.selection === "ranked") !== (item.rank !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Rank is required exactly when selection is ranked",
      path: ["rank"],
    });
  }
});
export type ContextItem = z.infer<typeof ContextItemSchema>;

export const ContextWindowDecisionSchema = z.object({
  item_id: z.string().min(1),
  decision: z.enum(["included", "trimmed", "blocked"]),
  reason: z.string().min(1),
  planned_tokens: z.number().int().nonnegative(),
}).strict();
export type ContextWindowDecision = z.infer<typeof ContextWindowDecisionSchema>;

export const DroppedContextWindowDecisionSchema = ContextWindowDecisionSchema.extend({
  decision: z.enum(["trimmed", "blocked"]),
}).strict();

export const ContextWindowAllocationsSchema = z.object({
  current_input: z.number().int().nonnegative().optional(),
  instructions: z.number().int().nonnegative().optional(),
  history: z.number().int().nonnegative().optional(),
  checkpoint_tail: z.number().int().nonnegative().optional(),
  skills: z.number().int().nonnegative().optional(),
  attachments: z.number().int().nonnegative().optional(),
  retrieval: z.number().int().nonnegative().optional(),
  tool_results: z.number().int().nonnegative().optional(),
}).strict();
export type ContextWindowAllocations = z.infer<typeof ContextWindowAllocationsSchema>;

export const ContextWindowPlanSchema = z.object({
  model: z.string().min(1),
  model_catalog_version: z.string().min(1),
  tokenizer_version: z.string().min(1),
  total_window_tokens: z.number().int().positive(),
  reserved_output_tokens: z.number().int().nonnegative(),
  provider_overhead_tokens: z.number().int().nonnegative(),
  planned_prompt_tokens: z.number().int().nonnegative(),
  allocations: ContextWindowAllocationsSchema,
  decisions: z.array(ContextWindowDecisionSchema),
  overflow_blockers: z.array(z.string()),
}).strict().superRefine((plan, context) => {
  const decisionIds = new Set<string>();
  for (const [index, decision] of plan.decisions.entries()) {
    if (decisionIds.has(decision.item_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Window decisions must have unique item ids",
        path: ["decisions", index, "item_id"],
      });
    }
    decisionIds.add(decision.item_id);
  }
  const committedTokens = plan.planned_prompt_tokens
    + plan.reserved_output_tokens
    + plan.provider_overhead_tokens;
  if (committedTokens > plan.total_window_tokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "planned prompt, output reserve, and provider overhead exceed the model window",
      path: ["planned_prompt_tokens"],
    });
  }
  const plannedFromDecisions = plan.decisions
    .filter((decision) => decision.decision !== "blocked")
    .reduce((total, decision) => total + decision.planned_tokens, 0);
  if (plannedFromDecisions !== plan.planned_prompt_tokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "planned_prompt_tokens must equal included and trimmed decision tokens",
      path: ["planned_prompt_tokens"],
    });
  }
  const plannedFromAllocations = Object.values(plan.allocations)
    .reduce<number>((total, allocation) => total + (allocation ?? 0), 0);
  if (plannedFromAllocations !== plan.planned_prompt_tokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "allocation tokens must sum to planned_prompt_tokens",
      path: ["allocations"],
    });
  }
  for (const [index, decision] of plan.decisions.entries()) {
    if (decision.decision === "blocked" && decision.planned_tokens !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blocked decisions cannot reserve prompt tokens",
        path: ["decisions", index, "planned_tokens"],
      });
    }
  }
});
export type ContextWindowPlan = z.infer<typeof ContextWindowPlanSchema>;

export const RuntimeContextEnvelopeSchema = z.object({
  id: IdSchema,
  execution_control_snapshot_id: IdSchema,
  setup_ref: RefSchema.nullable(),
  turn_request: TurnContextRequestSchema,
  items: z.array(ContextItemSchema),
  source_trace: z.array(RefSchema),
  window_plan: ContextWindowPlanSchema,
}).strict().superRefine((envelope, context) => {
  const itemsById = new Map(envelope.items.map((item) => [item.id, item]));
  if (itemsById.size !== envelope.items.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Context item ids must be unique",
      path: ["items"],
    });
  }
  const decisionIds = new Set<string>();
  for (const [index, decision] of envelope.window_plan.decisions.entries()) {
    if (decisionIds.has(decision.item_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each context item must have exactly one window decision",
        path: ["window_plan", "decisions", index, "item_id"],
      });
    }
    decisionIds.add(decision.item_id);
    const item = itemsById.get(decision.item_id);
    if (!item) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Window decision refers to an unknown context item",
        path: ["window_plan", "decisions", index, "item_id"],
      });
    } else if (item.selection !== "ranked" && decision.decision !== "included") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Required and pinned context items must be included without trimming",
        path: ["window_plan", "decisions", index, "decision"],
      });
    } else if (item.selection !== "ranked" && decision.planned_tokens !== item.token_estimate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Required and pinned items must reserve their full token estimate",
        path: ["window_plan", "decisions", index, "planned_tokens"],
      });
    } else if (item.selection === "ranked"
      && decision.decision === "included"
      && decision.planned_tokens !== item.token_estimate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Included ranked items must reserve their full token estimate",
        path: ["window_plan", "decisions", index, "planned_tokens"],
      });
    } else if (item.selection === "ranked"
      && decision.decision === "trimmed"
      && decision.planned_tokens > item.token_estimate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Trimmed ranked items cannot exceed their token estimate",
        path: ["window_plan", "decisions", index, "planned_tokens"],
      });
    }
  }
  for (const [index, item] of envelope.items.entries()) {
    if (!decisionIds.has(item.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Every context item requires a window decision",
        path: ["items", index, "id"],
      });
    }
  }
  const currentMessageKey = refKey(envelope.turn_request.current_message_ref);
  const currentMessage = envelope.items.find((item) =>
    refKey(item.source_ref) === currentMessageKey
    && item.acquisition === "direct"
    && item.selection === "required"
    && item.semantic_role === "user_input");
  const currentDecision = currentMessage
    ? envelope.window_plan.decisions.find((decision) => decision.item_id === currentMessage.id)
    : null;
  if (!currentMessage || currentDecision?.decision !== "included") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Current message must be a direct required user_input item with an included decision",
      path: ["turn_request", "current_message_ref"],
    });
  }
});
export type RuntimeContextEnvelope = z.infer<typeof RuntimeContextEnvelopeSchema>;

export const InvocationAuditRefsSchema = z.object({
  delivery_id: IdSchema,
  invocation_snapshot_id: IdSchema,
  execution_control_snapshot_id: IdSchema,
  usage_source_id: z.string().min(1),
}).strict();
export type InvocationAuditRefs = z.infer<typeof InvocationAuditRefsSchema>;

export const InvocationDeliverySchema = z.object({
  id: IdSchema,
  invocation_id: IdSchema,
  delivery_kind: z.enum(["agent_task", "provider_task"]),
  adapter_type: z.string().min(1),
  provider_id: IdSchema.nullable(),
  model: z.string().nullable(),
  renderer_version: z.string().min(1),
  mode: z.enum(["full", "delta"]),
  planned_items: z.array(z.object({
    item_id: z.string().min(1),
    semantic_role: RuntimeContextSemanticRoleSchema,
    required: z.boolean(),
  }).strict()).min(1),
  message_blocks: z.array(z.object({
    semantic_role: RuntimeContextSemanticRoleSchema,
    content: z.string().refine((content) => content.trim().length > 0, "content cannot be blank"),
    source_item_ids: z.array(z.string().min(1)).min(1),
    delivery_phase: z.enum(["bootstrap_context", "context_delta", "current_user"]).optional(),
  }).strict()),
  cli_session: z.object({
    binding_ref: RefSchema,
    runtime_state_key: IdSchema,
    vendor_session_id: z.string().trim().min(1).max(512).nullable(),
    cursor_from: z.number().int().nonnegative(),
    cursor_through: z.number().int().nonnegative(),
    generation: z.number().int().positive(),
    rotation_reason: z.string().trim().min(1).max(64).nullable(),
  }).strict().nullable().optional(),
  control_ref: RefSchema,
  sandbox_ref: RefSchema.nullable(),
  tool_grant_refs: z.array(RefSchema),
  output_contract_ref: RefSchema.nullable(),
  expected_prompt_tokens: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().nonnegative().nullable(),
  snapshot_draft_ref: RefSchema,
  audit_refs: InvocationAuditRefsSchema,
}).strict().superRefine((delivery, context) => {
  const planned = new Map(delivery.planned_items.map((item) => [item.item_id, item]));
  if (planned.size !== delivery.planned_items.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "planned item ids must be unique",
      path: ["planned_items"],
    });
  }
  const representedIds = delivery.message_blocks.flatMap((block) => block.source_item_ids);
  const represented = new Set(representedIds);
  if (represented.size !== representedIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Each planned item must be represented exactly once",
      path: ["message_blocks"],
    });
  }
  for (const [index, item] of delivery.planned_items.entries()) {
    if (!represented.has(item.item_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Every planned item must be represented in a delivery block",
        path: ["planned_items", index, "item_id"],
      });
    }
  }
  for (const [blockIndex, block] of delivery.message_blocks.entries()) {
    for (const [sourceIndex, itemId] of block.source_item_ids.entries()) {
      const plannedItem = planned.get(itemId);
      if (!plannedItem) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Delivery blocks may reference only planned context items",
          path: ["message_blocks", blockIndex, "source_item_ids", sourceIndex],
        });
      } else if (plannedItem.semantic_role !== block.semantic_role) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Delivery blocks must preserve each planned item's semantic role",
          path: ["message_blocks", blockIndex, "semantic_role"],
        });
      }
    }
  }
  if (delivery.delivery_kind === "agent_task"
    && (!delivery.planned_items.some((item) => item.required && item.semantic_role === "user_input")
      || delivery.message_blocks.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent-task deliveries require planned mandatory user input",
      path: ["planned_items"],
    });
  }
  if (delivery.cli_session) {
    if (delivery.cli_session.cursor_through < delivery.cli_session.cursor_from) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "CLI Delivery cursor cannot move backwards",
        path: ["cli_session", "cursor_through"],
      });
    }
    const currentBlocks = delivery.message_blocks.filter((block) => block.delivery_phase === "current_user");
    if (currentBlocks.length !== 1 || delivery.message_blocks.at(-1)?.delivery_phase !== "current_user") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "CLI Delivery requires exactly one final current-user block",
        path: ["message_blocks"],
      });
    }
  }
  if (delivery.audit_refs.delivery_id !== delivery.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "audit_refs.delivery_id must match delivery id",
      path: ["audit_refs", "delivery_id"],
    });
  }
  if (delivery.audit_refs.execution_control_snapshot_id !== delivery.control_ref.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "audit control id must match control_ref",
      path: ["audit_refs", "execution_control_snapshot_id"],
    });
  }
  if (delivery.audit_refs.invocation_snapshot_id !== delivery.snapshot_draft_ref.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "audit snapshot id must match snapshot_draft_ref",
      path: ["audit_refs", "invocation_snapshot_id"],
    });
  }
});
export type InvocationDelivery = z.infer<typeof InvocationDeliverySchema>;

export const ContextCaptureStatusSchema = z.enum(["complete", "recovered", "partial"]);

export const DeliveryAcknowledgementSchema = z.object({
  status: z.enum(["accepted", "rejected", "failed"]),
  acknowledged_at: ISODateTimeSchema,
  adapter_receipt_ref: RefSchema.nullable(),
}).strict();
export type DeliveryAcknowledgement = z.infer<typeof DeliveryAcknowledgementSchema>;

export const InvocationSnapshotSafeSchema = z.object({
  id: IdSchema,
  invocation_id: IdSchema,
  delivery_id: IdSchema,
  attempt: z.number().int().positive(),
  space_id: IdSchema,
  actor: RuntimeContextActorSchema,
  project_id: IdSchema.nullable(),
  project_folder_id: IdSchema.nullable(),
  agent_id: IdSchema.nullable(),
  work_context_scope_id: IdSchema.nullable(),
  runtime_session_binding_ref: RefSchema.nullable(),
  control_ref: RefSchema,
  setup_ref: RefSchema.nullable(),
  governing_policy_version_refs: z.array(RefSchema).min(1),
  audit_refs: InvocationAuditRefsSchema,
  source_refs: z.array(RefSchema),
  included_item_hashes: z.array(z.string()),
  dropped_items: z.array(DroppedContextWindowDecisionSchema),
  budget: ContextWindowPlanSchema,
  renderer_version: z.string().min(1),
  planned_tokens: z.number().int().nonnegative(),
  actual_tokens: z.number().int().nonnegative().nullable(),
  delivered_at: ISODateTimeSchema.nullable(),
  acknowledgement: DeliveryAcknowledgementSchema.nullable(),
  checkpoint_cursor: z.number().int().nonnegative().nullable(),
  cli_known_cursor: z.number().int().nonnegative().nullable(),
  capture_status: ContextCaptureStatusSchema,
  error_code: z.string().nullable(),
  dispatch_binding: z.object({
    request_fingerprint: z.string().min(1),
    bound_at: ISODateTimeSchema,
  }).strict().optional(),
  dispatch: z.object({
    request_fingerprint: z.string().min(1),
    dispatched_at: ISODateTimeSchema,
  }).strict().optional(),
  created_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.audit_refs.delivery_id !== snapshot.delivery_id
    || snapshot.audit_refs.invocation_snapshot_id !== snapshot.id
    || snapshot.audit_refs.execution_control_snapshot_id !== snapshot.control_ref.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Snapshot audit references must match snapshot authorities",
      path: ["audit_refs"],
    });
  }
  if (snapshot.planned_tokens !== snapshot.budget.planned_prompt_tokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "planned_tokens must match budget.planned_prompt_tokens",
      path: ["planned_tokens"],
    });
  }
  const expectedDropped = snapshot.budget.decisions
    .filter((decision) => decision.decision !== "included")
    .map(windowDecisionKey)
    .sort();
  const actualDropped = snapshot.dropped_items.map(windowDecisionKey).sort();
  if (expectedDropped.length !== actualDropped.length
    || expectedDropped.some((decision, index) => decision !== actualDropped[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "dropped_items must exactly match non-included budget decisions",
      path: ["dropped_items"],
    });
  }
});
export type InvocationSnapshotSafe = z.infer<typeof InvocationSnapshotSafeSchema>;

export const SemanticCheckpointCorrectionRequestSchema = z.object({
  checkpoint_id: IdSchema,
  canonical_ref: RefSchema,
  correction: JsonObjectSchema,
}).strict();

export const ContextEventSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  work_context_scope_id: IdSchema,
  scope_sequence: z.number().int().positive(),
  event_type: z.string().trim().min(1).max(64),
  canonical_ref: RefSchema,
  actor_user_id: IdSchema.nullable(),
  agent_id: IdSchema.nullable(),
  invocation_id: IdSchema.nullable(),
  semantic_role: RuntimeContextSemanticRoleSchema.nullable(),
  trust: RuntimeContextTrustSchema,
  sensitivity: RuntimeContextSensitivitySchema,
  token_estimate: z.number().int().nonnegative(),
  confirmation_state: z.enum(["observed", "candidate", "confirmed", "corrected"]),
  source_refs: z.array(RefSchema),
  capture_status: ContextCaptureStatusSchema,
  created_at: ISODateTimeSchema,
}).strict();
export type ContextEvent = z.infer<typeof ContextEventSchema>;

/**
 * Untrusted adapter/runtime report. The gateway resolves the invocation's
 * scope and derives sequence, actor, trust, sensitivity, confirmation, and
 * capture status before persisting a ContextEvent.
 */
export const RuntimeContextEventIngressSchema = z.object({
  invocation_id: IdSchema,
  event_type: z.string().trim().min(1).max(64),
  canonical_ref: RefSchema,
  semantic_role: RuntimeContextSemanticRoleSchema.nullable(),
  token_estimate: z.number().int().nonnegative(),
}).strict();
export type RuntimeContextEventIngress = z.infer<typeof RuntimeContextEventIngressSchema>;

export const MicroCheckpointCaptureGapSchema = z.object({
  code: z.string().trim().min(1).max(64),
  after_cursor: z.number().int().nonnegative(),
  before_cursor: z.number().int().nonnegative().nullable(),
  detail: z.string().trim().max(2000).nullable(),
}).strict().superRefine((gap, context) => {
  if (gap.before_cursor !== null && gap.before_cursor <= gap.after_cursor) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "before_cursor must be greater than after_cursor",
      path: ["before_cursor"],
    });
  }
});

export const MicroCheckpointSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  work_context_scope_id: IdSchema,
  version: z.number().int().positive(),
  event_head_cursor: z.number().int().nonnegative(),
  checkpoint_cursor: z.number().int().nonnegative(),
  cli_known_cursor: z.number().int().nonnegative().nullable(),
  capture_status: ContextCaptureStatusSchema,
  message_refs: z.array(RefSchema),
  artifact_refs: z.array(RefSchema),
  tool_refs: z.array(RefSchema),
  invocation_snapshot_refs: z.array(RefSchema),
  capture_gaps: z.array(MicroCheckpointCaptureGapSchema),
  created_at: ISODateTimeSchema,
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.checkpoint_cursor > checkpoint.event_head_cursor) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "checkpoint_cursor cannot exceed event_head_cursor",
      path: ["checkpoint_cursor"],
    });
  }
  if (checkpoint.cli_known_cursor !== null && checkpoint.cli_known_cursor > checkpoint.event_head_cursor) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cli_known_cursor cannot exceed event_head_cursor",
      path: ["cli_known_cursor"],
    });
  }
  if (checkpoint.capture_status === "complete" && checkpoint.capture_gaps.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "complete checkpoints cannot contain capture gaps",
      path: ["capture_gaps"],
    });
  }
  if (checkpoint.capture_status === "partial" && checkpoint.capture_gaps.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "partial checkpoints must identify at least one capture gap",
      path: ["capture_gaps"],
    });
  }
});
export type MicroCheckpoint = z.infer<typeof MicroCheckpointSchema>;

export const SemanticCheckpointStatementSchema = z.object({
  id: IdSchema,
  text: z.string().trim().min(1).max(10_000),
  confirmation_state: z.enum(["candidate", "confirmed", "corrected"]),
  source_refs: z.array(RefSchema).min(1),
}).strict();

export const SemanticCheckpointFactSchema = SemanticCheckpointStatementSchema.extend({
  fact_status: z.enum(["asserted", "disputed", "superseded"]),
}).strict();

export const SemanticCheckpointTaskSchema = z.object({
  id: IdSchema,
  text: z.string().trim().min(1).max(10_000),
  status: z.enum(["open", "in_progress", "blocked", "completed"]),
  source_refs: z.array(RefSchema).min(1),
}).strict();

export const SemanticCheckpointSourceSchema = z.object({
  ref: RefSchema,
  confirmation_authority: z.enum(["none", "canonical_user", "approved_domain"]),
}).strict();

const SemanticCheckpointExtractionStatementSchema = z.object({
  id: IdSchema,
  text: z.string().trim().min(1).max(10_000),
  confirmation_state: z.literal("candidate"),
  source_refs: z.array(RefSchema).min(1),
}).strict();

/**
 * Strict one-shot extractor output. It deliberately cannot claim confirmation
 * authority; the gateway resolves every cited ref against canonical records
 * before constructing a persisted SemanticCheckpoint.
 */
export const SemanticCheckpointExtractionSchema = z.object({
  goals: z.array(SemanticCheckpointExtractionStatementSchema),
  user_intent: z.array(SemanticCheckpointExtractionStatementSchema),
  decisions: z.array(SemanticCheckpointExtractionStatementSchema),
  constraints: z.array(SemanticCheckpointExtractionStatementSchema),
  facts: z.array(SemanticCheckpointExtractionStatementSchema.extend({
    fact_status: z.enum(["asserted", "disputed", "superseded"]),
  }).strict()),
  open_questions: z.array(SemanticCheckpointExtractionStatementSchema),
  tasks: z.array(z.object({
    id: IdSchema,
    text: z.string().trim().min(1).max(10_000),
    status: z.enum(["open", "in_progress", "blocked", "completed"]),
    source_refs: z.array(RefSchema).min(1),
  }).strict()),
  artifact_refs: z.array(RefSchema),
  tool_refs: z.array(RefSchema),
  correction_refs: z.array(RefSchema),
}).strict();
export type SemanticCheckpointExtraction = z.infer<typeof SemanticCheckpointExtractionSchema>;

/** Server-enriched persisted projection; never parse extractor output with this schema. */
export const SemanticCheckpointSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  work_context_scope_id: IdSchema,
  version: z.number().int().positive(),
  covered_cursor: z.number().int().nonnegative(),
  goals: z.array(SemanticCheckpointStatementSchema),
  user_intent: z.array(SemanticCheckpointStatementSchema),
  decisions: z.array(SemanticCheckpointStatementSchema),
  constraints: z.array(SemanticCheckpointStatementSchema),
  facts: z.array(SemanticCheckpointFactSchema),
  open_questions: z.array(SemanticCheckpointStatementSchema),
  tasks: z.array(SemanticCheckpointTaskSchema),
  artifact_refs: z.array(RefSchema),
  tool_refs: z.array(RefSchema),
  correction_refs: z.array(RefSchema),
  source_refs: z.array(SemanticCheckpointSourceSchema),
  extractor_ref: RefSchema,
  created_at: ISODateTimeSchema,
}).strict().superRefine((checkpoint, context) => {
  const sourcesByRef = new Map(checkpoint.source_refs.map((source) => [refKey(source.ref), source]));
  const citedRefs = [
    ...checkpoint.goals,
    ...checkpoint.user_intent,
    ...checkpoint.decisions,
    ...checkpoint.constraints,
    ...checkpoint.facts,
    ...checkpoint.open_questions,
    ...checkpoint.tasks,
  ].flatMap((entry) => entry.source_refs);
  for (const cited of citedRefs) {
    if (!sourcesByRef.has(refKey(cited))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Checkpoint entry cites a ref absent from source_refs",
        path: ["source_refs"],
      });
    }
  }
  const confirmedEntries = [
    ...checkpoint.goals,
    ...checkpoint.user_intent,
    ...checkpoint.decisions,
    ...checkpoint.constraints,
    ...checkpoint.facts,
    ...checkpoint.open_questions,
  ].filter((entry) => entry.confirmation_state === "confirmed");
  for (const entry of confirmedEntries) {
    const hasAuthority = entry.source_refs.some((cited) => {
      const source = sourcesByRef.get(refKey(cited));
      return source?.confirmation_authority === "canonical_user"
        || source?.confirmation_authority === "approved_domain";
    });
    if (!hasAuthority) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Confirmed checkpoint entry requires canonical user or approved domain evidence",
        path: ["source_refs"],
      });
    }
  }
});
export type SemanticCheckpoint = z.infer<typeof SemanticCheckpointSchema>;

function refKey(ref: z.infer<typeof RefSchema>): string {
  return `${ref.type}\u0000${ref.id}\u0000${ref.version ?? ""}`;
}

function windowDecisionKey(decision: z.infer<typeof ContextWindowDecisionSchema>): string {
  return JSON.stringify([
    decision.item_id,
    decision.decision,
    decision.reason,
    decision.planned_tokens,
  ]);
}
