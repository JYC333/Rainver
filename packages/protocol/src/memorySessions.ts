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

export const SessionOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    user_id: IdSchema.nullish(),
    project_folder_id: IdSchema.nullish(),
    project_id: IdSchema.nullish(),
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
    project_id: IdSchema.nullish(),
    title: z.string().nullish(),
    metadata: JsonObjectSchema.nullish(),
  })
  .passthrough();

export const MessageCreateRequestSchema = z
  .object({
    content: z.string().min(1),
  })
  .strict();

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

export const ChatTurnPrepareRunResultSchema = z
  .object({
    session_id: IdSchema,
    run_id: IdSchema,
    ...SecretResponseGuards,
  })
  .passthrough();

export const MemoryScopeSchema = z.enum(["user", "project"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    subject_user_id: IdSchema.nullish(),
    owner_user_id: IdSchema.nullish(),
    scope: MemoryScopeSchema,
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

const MemoryCreateFieldsSchema = z.object({
  title: z.string(),
  content: z.string(),
  type: z.string(),
  scope: MemoryScopeSchema.default("user"),
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
  project_id: IdSchema.nullish(),
  memory_layer: z.string().nullish(),
});

const MemoryUpdateFieldsSchema = z.object({
  title: z.string().nullish(),
  content: z.string().nullish(),
  type: z.string().nullish(),
  scope: MemoryScopeSchema.nullish(),
  namespace: z.string().nullish(),
  visibility: z.string().nullish(),
  access_level: z.string().nullish(),
  sensitivity_level: z.string().nullish(),
  confidence: z.number().nullish(),
  importance: z.number().nullish(),
  tags: z.array(z.string()).nullish(),
  subject_user_id: IdSchema.nullish(),
  owner_user_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
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
  })
  .passthrough();

export const MemoryReadRequestSchema = z.object({
  space_id: IdSchema,
  user_id: IdSchema.nullish(),
  agent_id: IdSchema.nullish(),
  run_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  memory_id: IdSchema.nullish(),
  query: z.string().nullish(),
  limit: z.number().int().nonnegative().default(50),
  offset: z.number().int().nonnegative().default(0),
  reason: z.string().nullish(),
});

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
export type MemoryMaintenanceScanRequestInput = z.input<typeof MemoryMaintenanceScanRequestSchema>;

export const MemoryMaintenanceJobStatusSchema = z.enum(["pending", "running", "completed", "failed"]);

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
