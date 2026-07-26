/**
 * Memory + sessions contracts.
 *
 * Schemas only. These contracts describe public wire shapes. They do not create
 * route handlers or move authority.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import { TraceSafeJsonSchema } from "./runOrchestration.js";

const JsonObjectSchema = z.record(z.unknown());
const TraceSafeObjectSchema = TraceSafeJsonSchema.refine(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  "Expected trace-safe object",
);
const TraceSafeArraySchema = z.array(TraceSafeJsonSchema);
const RawContextResponseGuards = {
  compiled_prefix_text: z.never().optional(),
  compiled_tail_text: z.never().optional(),
  rendered_context_text: z.never().optional(),
};

export const SessionOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    user_id: IdSchema.nullish(),
    project_folder_id: IdSchema.nullish(),
    project_id:IdSchema.nullish(),
    room_id: IdSchema.nullish(),
    title: z.string().nullish(),
    status: z.string(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type SessionOut = z.infer<typeof SessionOutSchema>;

export const MessageOutSchema = z
  .object({
    id: IdSchema,
    session_id: IdSchema,
    space_id: IdSchema,
    user_id: IdSchema.nullish(),
    sender_agent_id: IdSchema.nullish(),
    role: z.string(),
    content: z.string(),
    metadata_json: JsonObjectSchema.nullish(),
    created_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type MessageOut = z.infer<typeof MessageOutSchema>;

export const SessionPageSchema = z
  .object({
    items: z.array(SessionOutSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type SessionPage = z.infer<typeof SessionPageSchema>;

export const SessionCreateRequestSchema = z
  .object({
    space_id: IdSchema.nullish(),
    user_id: IdSchema.nullish(),
    project_folder_id: IdSchema.nullish(),
    title: z.string().nullish(),
    metadata: JsonObjectSchema.nullish(),
  })
  .passthrough();
export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;

export const MessageCreateRequestSchema = z
  .object({
    content: z.string().min(1),
  })
  .strict();
export type MessageCreateRequest = z.infer<typeof MessageCreateRequestSchema>;

export const SessionSummaryForContextSchema = z
  .object({
    id: IdSchema,
    session_id: IdSchema,
    version: z.number().int().positive(),
    summary_text: z.string(),
    condenser_version: z.string(),
    source_message_count: z.number().int().nonnegative().nullish(),
    source_first_message_id: IdSchema.nullish(),
    source_last_message_id: IdSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type SessionSummaryForContext = z.infer<
  typeof SessionSummaryForContextSchema
>;

export const SessionSummaryGetLatestRequestSchema = z.object({
  session_id: IdSchema,
  space_id: IdSchema,
});
export type SessionSummaryGetLatestRequest = z.infer<
  typeof SessionSummaryGetLatestRequestSchema
>;

export const SessionSummaryGetLatestResultSchema = z
  .object({
    summary: SessionSummaryForContextSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type SessionSummaryGetLatestResult = z.infer<
  typeof SessionSummaryGetLatestResultSchema
>;

export const ChatTurnRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(8000),
    session_id: IdSchema.nullish(),
    project_id: IdSchema.nullish(),
    backend: z.object({
      runtime_profile_id: IdSchema,
      credential_profile_id: IdSchema.nullish(),
    }).strict().optional(),
  })
  .strict();
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>;

export const ConversationBackendBindingSchema = z.object({
  runtime_profile_id: IdSchema,
  adapter_type: z.string().trim().min(1),
  credential_profile_id: IdSchema.nullish(),
}).strict();
export type ConversationBackendBinding = z.infer<
  typeof ConversationBackendBindingSchema
>;

export const ConversationBackendOptionSchema = z.object({
  runtime_profile_id: IdSchema,
  name: z.string().trim().min(1),
  adapter_type: z.string().trim().min(1),
  model_name: z.string().nullish(),
  requires_cli_credential: z.boolean(),
  credential_profiles: z.array(z.object({
    id: IdSchema,
    name: z.string().trim().min(1),
    is_default: z.boolean(),
  }).strict()),
}).strict();
export type ConversationBackendOption = z.infer<
  typeof ConversationBackendOptionSchema
>;

export const ConversationBackendCatalogSchema = z.object({
  options: z.array(ConversationBackendOptionSchema),
  binding: ConversationBackendBindingSchema.nullable(),
}).strict();
export type ConversationBackendCatalog = z.infer<
  typeof ConversationBackendCatalogSchema
>;

export const AssistantMessageSchema = z
  .object({
    schema_version: z.literal("assistant_message.v1"),
    id: IdSchema,
    session_id: IdSchema,
    run_id: IdSchema,
    content: z.string(),
    artifact_refs: z.array(IdSchema).default([]),
    tool_call_refs: z.array(z.string().min(1)).default([]),
    created_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .strict();
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const ChatTurnAcceptedSchema = z
  .object({
    schema_version: z.literal("chat_turn_accepted.v1"),
    session_id: IdSchema,
    run_id: IdSchema,
    user_message_id: IdSchema,
    status: z.literal("queued"),
    event_stream_url: z.string().min(1),
    backend: ConversationBackendBindingSchema,
    ...SecretResponseGuards,
  })
  .strict();
export type ChatTurnAccepted = z.infer<typeof ChatTurnAcceptedSchema>;

export const ChatTurnCompletionSchema = z
  .object({
    schema_version: z.literal("chat_turn_completion.v1"),
    session_id: IdSchema,
    run_id: IdSchema,
    ok: z.boolean(),
    reply: z.string().nullish(),
    error: z.string().nullish(),
    error_code: z.string().nullish(),
    assistant_message: AssistantMessageSchema.nullish(),
    action_previews: z
      .array(
        z.object({
          action_id: z.string(),
          tool_call_id: z.string().nullish(),
          status: z.enum(["proposed", "auto_applied", "completed", "failed"]),
          proposal_id: IdSchema.nullish(),
          proposal_type: z.string().nullish(),
          title: z.string().nullish(),
          summary: z.string().nullish(),
          risk_level: z.string().nullish(),
          scope: JsonObjectSchema.nullish(),
        }),
      )
      .optional(),
    ...SecretResponseGuards,
  })
  .strict();
export type ChatTurnCompletion = z.infer<typeof ChatTurnCompletionSchema>;

export const ChatTurnPrepareRunRequestSchema = z.object({
  agent_id: IdSchema,
  space_id: IdSchema,
  user_id: IdSchema,
  session_id: IdSchema,
  message: z.string().min(1).max(8000),
});
export type ChatTurnPrepareRunRequest = z.infer<
  typeof ChatTurnPrepareRunRequestSchema
>;

export const ChatTurnPrepareRunResultSchema = z
  .object({
    session_id: IdSchema,
    run_id: IdSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type ChatTurnPrepareRunResult = z.infer<
  typeof ChatTurnPrepareRunResultSchema
>;

/**
 * Context assembly for the chat path. The server chat turn owns the
 * `ChatContextBuilder` selection/budget loop, candidate reads, and
 * `context_snapshots` / `context_snapshot_items` persistence.
 */
export const ChatContextCandidateItemSchema = z
  .object({
    item_type: z.string(),
    item_id: IdSchema.nullish(),
    title: z.string().nullish(),
    excerpt: z.string().nullish(),
    score: z.number().nullish(),
    reason: z.string().nullish(),
    token_count: z.number().int().nonnegative().nullish(),
    metadata: TraceSafeObjectSchema.default({}),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ChatContextCandidateItem = z.infer<
  typeof ChatContextCandidateItemSchema
>;

export const ChatContextCandidatesRequestSchema = z.object({
  agent_id: IdSchema,
  space_id: IdSchema,
  user_id: IdSchema,
  session_id: IdSchema,
  message: z.string().min(1).max(8000),
  project_id:IdSchema.nullish(),
});
export type ChatContextCandidatesRequest = z.infer<
  typeof ChatContextCandidatesRequestSchema
>;

export const ChatContextCandidatesResultSchema = z
  .object({
    allowed_sources: z.array(z.string()).default([]),
    max_tokens: z.number().int().positive(),
    max_items: z.number().int().positive(),
    context_policy_applied: z.boolean(),
    items: z.array(ChatContextCandidateItemSchema).default([]),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ChatContextCandidatesResult = z.infer<
  typeof ChatContextCandidatesResultSchema
>;

export const ChatRunCreateRequestSchema = z.object({
  agent_id: IdSchema,
  space_id: IdSchema,
  user_id: IdSchema,
  session_id: IdSchema,
  prompt: z.string().min(1),
});
export type ChatRunCreateRequest = z.infer<typeof ChatRunCreateRequestSchema>;

export const ChatRunCreateResultSchema = z
  .object({
    run_id: IdSchema,
    context_snapshot_id: IdSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ChatRunCreateResult = z.infer<typeof ChatRunCreateResultSchema>;

export const MemoryOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    subject_user_id: IdSchema.nullish(),
    owner_user_id: IdSchema.nullish(),
    project_folder_id: IdSchema.nullish(),
    scope: z.string(),
    namespace: z.string().nullish(),
    type: z.string(),
    title: z.string().nullish(),
    content: z.string().nullish(),
    status: z.string(),
    visibility: z.string(),
    access_level: z.string(),
    sensitivity_level: z.string(),
    last_confirmed_at: ISODateTimeSchema.nullish(),
    confidence: z.number(),
    importance: z.number(),
    created_by: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    deleted_at: ISODateTimeSchema.nullish(),
    version: z.number().int(),
    tags: z.array(z.unknown()).nullish(),
    memory_layer: z.string().nullish(),
    source_trust: z.string().nullish(),
    created_from_proposal_id: IdSchema.nullish(),
    root_memory_id: IdSchema.nullish(),
    supersedes_memory_id: IdSchema.nullish(),
    project_id: IdSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type MemoryOut = z.infer<typeof MemoryOutSchema>;

export const MemoryProposalOperationSchema = z.enum([
  "create",
  "update",
  "archive",
]);
export type MemoryProposalOperation = z.infer<
  typeof MemoryProposalOperationSchema
>;

const MemoryCreateFieldsSchema = z.object({
  title: z.string(),
  content: z.string(),
  type: z.string(),
  scope: z.string().default("user"),
  namespace: z.string().default("user.default"),
  visibility: z.string().nullish(),
  access_level: z.string().default("full"),
  sensitivity_level: z.string().default("normal"),
  confidence: z.number().default(1),
  importance: z.number().default(0.5),
  tags: z.array(z.string()).nullish(),
  source_id: IdSchema.nullish(),
  space_id: IdSchema.nullish(),
  subject_user_id: IdSchema.nullish(),
  owner_user_id: IdSchema.nullish(),
  last_confirmed_at: ISODateTimeSchema.nullish(),
  project_folder_id: IdSchema.nullish(),
  memory_layer: z.string().nullish(),
});

const MemoryUpdateFieldsSchema = z.object({
  title: z.string().nullish(),
  content: z.string().nullish(),
  type: z.string().nullish(),
  scope: z.string().nullish(),
  namespace: z.string().nullish(),
  visibility: z.string().nullish(),
  access_level: z.string().nullish(),
  sensitivity_level: z.string().nullish(),
  confidence: z.number().nullish(),
  importance: z.number().nullish(),
  tags: z.array(z.string()).nullish(),
  subject_user_id: IdSchema.nullish(),
  owner_user_id: IdSchema.nullish(),
  project_folder_id: IdSchema.nullish(),
  memory_layer: z.string().nullish(),
});

export const MemoryProposalCreateCommandSchema = MemoryCreateFieldsSchema.extend({
  operation: z.literal("create"),
  actor_user_id: IdSchema.nullish(),
  provenance_entries: z.array(TraceSafeObjectSchema).default([]),
});
export type MemoryProposalCreateCommand = z.infer<
  typeof MemoryProposalCreateCommandSchema
>;

export const MemoryProposalUpdateCommandSchema = MemoryUpdateFieldsSchema.extend({
  operation: z.literal("update"),
  target_memory_id: IdSchema,
  actor_user_id: IdSchema.nullish(),
  provenance_entries: z.array(TraceSafeObjectSchema).default([]),
});
export type MemoryProposalUpdateCommand = z.infer<
  typeof MemoryProposalUpdateCommandSchema
>;

export const MemoryProposalArchiveCommandSchema = z.object({
  operation: z.literal("archive"),
  target_memory_id: IdSchema,
  project_folder_id: IdSchema.nullish(),
  actor_user_id: IdSchema.nullish(),
  provenance_entries: z.array(TraceSafeObjectSchema).default([]),
});
export type MemoryProposalArchiveCommand = z.infer<
  typeof MemoryProposalArchiveCommandSchema
>;

export const MemoryProposalCommandSchema = z.discriminatedUnion("operation", [
  MemoryProposalCreateCommandSchema,
  MemoryProposalUpdateCommandSchema,
  MemoryProposalArchiveCommandSchema,
]);
export type MemoryProposalCommand = z.infer<
  typeof MemoryProposalCommandSchema
>;

export const MemoryProposalCreateResultSchema = z
  .object({
    proposal_id: IdSchema,
    proposal_type: z.enum([
      "memory_create",
      "memory_update",
      "memory_archive",
    ]),
    status: z.string(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type MemoryProposalCreateResult = z.infer<
  typeof MemoryProposalCreateResultSchema
>;

/**
 * Public `POST /memory/search` body. `space_id`/
 * `user_id` override the caller's identity; `type` is the wire name for
 * `memory_type`. `include_system` is an opt-in: by default the user-facing
 * search hides `scope=system` seed memories (system policy rows) so they do not
 * appear as user memory hits; pass it (or an explicit `scope=system`) to include
 * them.
 */
// Memory search is identity-scoped: the surface intentionally has no space_id /
// user_id fields. The server derives both from the authenticated identity, so a
// request can never search another space or impersonate another user
// (SECURITY_AND_ACCESS_BOUNDARIES §2).
export const MemorySearchRequestSchema = z
  .object({
    query: z.string(),
    scope: z.string().nullish(),
    namespace: z.string().nullish(),
    type: z.string().nullish(),
    limit: z.number().int().nonnegative().default(10),
    project_folder_id: IdSchema.nullish(),
    include_system: z.boolean().default(false),
  })
  .passthrough();
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;

export const MemoryReadRequestSchema = z.object({
  space_id: IdSchema,
  user_id: IdSchema.nullish(),
  agent_id: IdSchema.nullish(),
  run_id: IdSchema.nullish(),
  project_folder_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  memory_id: IdSchema.nullish(),
  query: z.string().nullish(),
  limit: z.number().int().nonnegative().default(50),
  offset: z.number().int().nonnegative().default(0),
  include_system_scope: z.boolean().default(false),
  reason: z.string().nullish(),
});
export type MemoryReadRequest = z.infer<typeof MemoryReadRequestSchema>;

export const MemoryPageSchema = z
  .object({
    items: z.array(MemoryOutSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type MemoryPage = z.infer<typeof MemoryPageSchema>;

export const MemoryReadTraceSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    memory_id: IdSchema,
    user_id: IdSchema.nullish(),
    agent_id: IdSchema.nullish(),
    run_id: IdSchema.nullish(),
    access_type: z.string(),
    reason: z.string().nullish(),
    accessed_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type MemoryReadTrace = z.infer<typeof MemoryReadTraceSchema>;

export const MemoryMaintenanceFindingKindSchema = z.enum([
  "duplicate",
  "stale",
  "thin",
  "lifecycle_drift",
  "archived_state_drift",
  "project_drift",
  "source_policy_drift",
  "contradiction",
]);
export type MemoryMaintenanceFindingKind = z.infer<typeof MemoryMaintenanceFindingKindSchema>;

export const MemoryMaintenanceObjectSchema = z
  .object({
    object_type: z.literal("memory_entry"),
    object_id: IdSchema,
    title: z.string().nullable(),
  })
  .strict();
export type MemoryMaintenanceObject = z.infer<typeof MemoryMaintenanceObjectSchema>;

export const MemoryMaintenanceFindingSchema = z
  .object({
    kind: MemoryMaintenanceFindingKindSchema,
    objects: z.array(MemoryMaintenanceObjectSchema),
    reason: z.string(),
    cluster_key: z.string().trim().min(1).max(160).optional(),
    cluster_label: z.string().trim().min(1).max(240).optional(),
    confidence_tier: z.enum(["high", "medium", "low"]).optional(),
    proposed_action: z.record(z.unknown()).nullable().optional(),
  })
  .strict();
export type MemoryMaintenanceFinding = z.infer<typeof MemoryMaintenanceFindingSchema>;

export const MemoryMaintenanceScanRequestSchema = z
  .object({
    persist_report: z.boolean().default(true),
    create_packet: z.boolean().default(false),
    limit: z.number().int().positive().max(1000).default(500),
    stale_after_days: z.number().int().positive().max(3650).default(180),
    thin_content_chars: z.number().int().positive().max(1000).default(80),
    max_findings: z.number().int().positive().max(200).default(100),
    review_scope: z.enum(["private", "space_ops"]).default("private"),
    project_id: IdSchema.nullish(),
    scan_mode: z.enum(["recent", "full"]).default("recent"),
    cursor: z.string().trim().min(1).max(256).optional(),
    job_id: IdSchema.optional(),
  })
  .strict();
export type MemoryMaintenanceScanRequest = z.infer<typeof MemoryMaintenanceScanRequestSchema>;

export const MemoryMaintenanceJobStatusSchema = z.enum(["pending", "running", "completed", "failed"]);
export type MemoryMaintenanceJobStatus = z.infer<typeof MemoryMaintenanceJobStatusSchema>;

export const MemoryMaintenanceReportSchema = z
  .object({
    findings: z.array(MemoryMaintenanceFindingSchema),
    counts: z.record(z.number().int().nonnegative()),
    candidate_limit: z.number().int().positive(),
    candidates_examined: z.number().int().nonnegative(),
    scanned: z.number().int().nonnegative(),
    truncated: z.boolean(),
    scan_mode: z.enum(["recent", "full"]).optional(),
    next_cursor: z.string().nullable().optional(),
    job_id: IdSchema.optional(),
    job_status: MemoryMaintenanceJobStatusSchema.optional(),
    artifact_id: IdSchema.optional(),
    proposal_id: IdSchema.optional(),
    access_safety: z.record(z.unknown()).optional(),
    ...SecretResponseGuards,
  })
  .strict();
export type MemoryMaintenanceReport = z.infer<typeof MemoryMaintenanceReportSchema>;

export const MemoryMaintenanceJobCreateRequestSchema = MemoryMaintenanceScanRequestSchema.omit({
  cursor: true,
  job_id: true,
}).extend({
  scan_mode: z.literal("full").default("full"),
});
export type MemoryMaintenanceJobCreateRequest = z.infer<typeof MemoryMaintenanceJobCreateRequestSchema>;

export const MemoryMaintenanceJobSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    owner_user_id: IdSchema,
    status: MemoryMaintenanceJobStatusSchema,
    review_scope: z.enum(["private", "space_ops"]),
    scan_options: z.record(z.unknown()),
    cursor: z.string().nullable(),
    total_scanned: z.number().int().nonnegative(),
    total_findings: z.number().int().nonnegative(),
    last_report_artifact_id: IdSchema.nullish(),
    last_packet_proposal_id: IdSchema.nullish(),
    error_message: z.string().nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    completed_at: ISODateTimeSchema.nullish(),
    ...SecretResponseGuards,
  })
  .strict();
export type MemoryMaintenanceJob = z.infer<typeof MemoryMaintenanceJobSchema>;

export const MemoryMaintenanceJobRunResponseSchema = z
  .object({
    job: MemoryMaintenanceJobSchema,
    report: MemoryMaintenanceReportSchema.nullable(),
    ...SecretResponseGuards,
  })
  .strict();
export type MemoryMaintenanceJobRunResponse = z.infer<typeof MemoryMaintenanceJobRunResponseSchema>;

export const MemoryAccessLogEntrySchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    memory_id: IdSchema,
    user_id: IdSchema.nullish(),
    agent_id: IdSchema.nullish(),
    run_id: IdSchema.nullish(),
    access_type: z.string(),
    reason: z.string().nullish(),
    accessed_at: ISODateTimeSchema,
    memory_title: z.string().nullable(),
    memory_scope: z.string().nullable(),
    memory_visibility: z.string().nullable(),
    project_id: IdSchema.nullish(),
    ...SecretResponseGuards,
  })
  .strict();
export type MemoryAccessLogEntry = z.infer<typeof MemoryAccessLogEntrySchema>;

export const MemoryAccessLogListResponseSchema = z
  .object({
    items: z.array(MemoryAccessLogEntrySchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    has_more: z.boolean(),
    ...SecretResponseGuards,
  })
  .strict();
export type MemoryAccessLogListResponse = z.infer<typeof MemoryAccessLogListResponseSchema>;

export const ContextSourceRefSchema = z
  .object({
    source_type: z.string(),
    source_id: IdSchema.nullish(),
    section: z.string().nullish(),
    title: z.string().nullish(),
    ...SecretResponseGuards,
  })
  .catchall(TraceSafeJsonSchema);
export type ContextSourceRef = z.infer<typeof ContextSourceRefSchema>;

export const ContextBuildRequestSchema = z.object({
  space_id: IdSchema,
  user_id: IdSchema.nullish(),
  project_folder_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  task_type: z.string().nullish(),
  capability_id: z.string().nullish(),
  session_id: IdSchema.nullish(),
  run_id: IdSchema.nullish(),
  query: z.string().nullish(),
  agent_id: IdSchema.nullish(),
  context_artifact_ids: z.array(IdSchema).max(8).default([]),
});
export type ContextBuildRequest = z.infer<typeof ContextBuildRequestSchema>;

export const ContextArtifactRevocationScopeSchema = z.enum(["project_folder", "project"]);
export type ContextArtifactRevocationScope = z.infer<typeof ContextArtifactRevocationScopeSchema>;

export const ContextArtifactRevocationSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    artifact_id: IdSchema,
    scope_type: ContextArtifactRevocationScopeSchema,
    scope_id: IdSchema,
    reason: z.string().nullish(),
    created_by_user_id: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .strict();
export type ContextArtifactRevocation = z.infer<typeof ContextArtifactRevocationSchema>;

export const ContextArtifactRevocationCreateRequestSchema = z
  .object({
    artifact_id: IdSchema,
    scope_type: ContextArtifactRevocationScopeSchema,
    scope_id: IdSchema,
    reason: z.string().max(512).nullish(),
  })
  .strict();
export type ContextArtifactRevocationCreateRequest = z.infer<typeof ContextArtifactRevocationCreateRequestSchema>;

export const ContextArtifactRevocationListResponseSchema = z
  .object({
    items: z.array(ContextArtifactRevocationSchema),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextArtifactRevocationListResponse = z.infer<typeof ContextArtifactRevocationListResponseSchema>;

export const ContextArtifactAttachmentSchema = z
  .object({
    attachment_type: z.literal("artifact_evidence_pack"),
    artifact_id: IdSchema.optional(),
    artifact_type: z.string().optional(),
    label: z.string(),
    domain_label: z.string().optional(),
    approved: z.boolean(),
    resolved_content: z.string().optional(),
    rejection_reason: z.string().optional(),
    policy_snapshot: TraceSafeObjectSchema.optional(),
    source_policy_snapshot: TraceSafeObjectSchema.optional(),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextArtifactAttachment = z.infer<typeof ContextArtifactAttachmentSchema>;

export const ContextPackageSchema = z
  .object({
    user_memory: z.array(MemoryOutSchema).default([]),
    project_folder_memory: z.array(MemoryOutSchema).default([]),
    capability_memory: z.array(MemoryOutSchema).default([]),
    agent_memory: z.array(MemoryOutSchema).default([]),
    system_policy: z.array(MemoryOutSchema).default([]),
    recent_session_summary: z.array(SessionSummaryForContextSchema).default([]),
    relevant_episodes: z.array(MemoryOutSchema).default([]),
    evidence_items: z.array(TraceSafeObjectSchema).default([]),
    attachments: z.array(ContextArtifactAttachmentSchema.or(TraceSafeObjectSchema)).default([]),
    active_policies: z.array(TraceSafeObjectSchema).default([]),
    stable_prefix_refs: z.array(ContextSourceRefSchema).default([]),
    dynamic_tail_refs: z.array(ContextSourceRefSchema).default([]),
    source_refs: z.array(ContextSourceRefSchema).default([]),
    retrieval_trace: TraceSafeObjectSchema.default({}),
    token_budget: TraceSafeObjectSchema.default({}),
    personal_context_block: z.string().default(""),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ContextPackage = z.infer<typeof ContextPackageSchema>;

export const ContextBuildResultSchema = z
  .object({
    package: ContextPackageSchema,
    context_snapshot_id: IdSchema.nullish(),
    memory_read_traces: z.array(MemoryReadTraceSchema).default([]),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ContextBuildResult = z.infer<typeof ContextBuildResultSchema>;

export const ContextCompileTargetSchema = z.enum([
  "claude",
  "codex_cli",
  "cursor",
  "generic",
  "soul",
  "prompt",
]);
export type ContextCompileTarget = z.infer<typeof ContextCompileTargetSchema>;

export const ContextCompileRequestSchema = z.object({
  space_id: IdSchema,
  target: ContextCompileTargetSchema,
  task_goal: z.string(),
  context_package: ContextPackageSchema,
  project_folder_path: z.string().nullish(),
  budget_chars: z.number().int().positive().nullish(),
});
export type ContextCompileRequest = z.infer<typeof ContextCompileRequestSchema>;

export const ContextCompileResultSchema = z
  .object({
    target: ContextCompileTargetSchema,
    task_prompt: z.string(),
    instruction_file_path: z.string().nullish(),
    total_chars: z.number().int().nonnegative(),
    budget_chars: z.number().int().positive(),
    dropped_sections: z.array(z.string()).default([]),
    budget_trace: TraceSafeObjectSchema.default({}),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ContextCompileResult = z.infer<
  typeof ContextCompileResultSchema
>;

export const ContextSnapshotAuditSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    source_refs_json: z.array(ContextSourceRefSchema).default([]),
    token_estimate: z.number().int().nonnegative().nullish(),
    relevant_period_start: ISODateTimeSchema.nullish(),
    relevant_period_end: ISODateTimeSchema.nullish(),
    prefix_hash: z.string().nullish(),
    tail_hash: z.string().nullish(),
    compiler_version: z.string().nullish(),
    retrieval_trace_json: TraceSafeArraySchema.nullish(),
    token_budget_json: TraceSafeObjectSchema.nullish(),
    policy_bundle_version: z.string().nullish(),
    memory_digest_version: z.string().nullish(),
    project_folder_digest_version: z.string().nullish(),
    included_memory_refs_json: z.array(ContextSourceRefSchema).nullish(),
    included_evidence_refs_json: z.array(ContextSourceRefSchema).nullish(),
    included_file_refs_json: z.array(ContextSourceRefSchema).nullish(),
    included_doc_refs_json: z.array(ContextSourceRefSchema).nullish(),
    redactions_json: TraceSafeObjectSchema.nullish(),
    data_exposure_level: z.string().nullish(),
    rendered_context_uri: z.string().nullish(),
    has_compiled_prefix_text: z.boolean().default(false),
    has_compiled_tail_text: z.boolean().default(false),
    has_rendered_context_text: z.boolean().default(false),
    created_at: ISODateTimeSchema,
    ...RawContextResponseGuards,
    ...SecretResponseGuards,
  })
  .passthrough();
export type ContextSnapshotAudit = z.infer<
  typeof ContextSnapshotAuditSchema
>;

export const ContextSnapshotItemAuditSchema = z
  .object({
    id: IdSchema,
    context_snapshot_id: IdSchema,
    item_type: z.string(),
    item_id: IdSchema.nullish(),
    title: z.string().nullish(),
    excerpt: z.string().nullish(),
    score: z.number().nullish(),
    reason: z.string().nullish(),
    token_count: z.number().int().nonnegative().nullish(),
    metadata_json: TraceSafeObjectSchema.default({}),
    created_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type ContextSnapshotItemAudit = z.infer<
  typeof ContextSnapshotItemAuditSchema
>;

export const ContextEngineEventTypeSchema = z.enum([
  "context.build_started",
  "context.session_summary_loaded",
  "context.memory_selected",
  "context.evidence_selected",
  "context.compaction_applied",
  "context.overflow_recovered",
  "context.snapshot_persisted",
  "context.build_completed",
  "context.build_failed",
]);
export type ContextEngineEventType = z.infer<
  typeof ContextEngineEventTypeSchema
>;

export const ContextEngineEventSchema = z
  .object({
    event_type: ContextEngineEventTypeSchema,
    space_id: IdSchema,
    session_id: IdSchema.nullish(),
    run_id: IdSchema.nullish(),
    context_snapshot_id: IdSchema.nullish(),
    status: z.enum(["started", "succeeded", "failed", "skipped", "warning"]),
    message: z.string().nullish(),
    metadata_json: TraceSafeObjectSchema.default({}),
    created_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type ContextEngineEvent = z.infer<typeof ContextEngineEventSchema>;
