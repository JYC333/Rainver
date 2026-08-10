/**
 * Run orchestration contracts.
 *
 * These schemas describe server-owned run orchestration. They are contracts
 * only: no route registration, queue worker,
 * database repository, policy decision, credential release, or adapter execution
 * authority lives in this package.
 */

import { z } from "zod";
import {
  IdSchema,
  ISODateTimeSchema,
  RunTriggerOriginSchema,
  SECRET_RESPONSE_FIELDS,
  SecretResponseGuards,
} from "./common.js";
import {
  CanonicalMessageSchema,
  CanonicalModelUsageSchema,
  CanonicalUsageSchema,
} from "./model.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const SECRET_KEYS = new Set<string>([
  ...SECRET_RESPONSE_FIELDS,
  "authorization",
  "cookie",
  "access_token",
  "refresh_token",
  "id_token",
  "password",
  "private_key",
]);

const TRACE_UNSAFE_KEYS = new Set<string>([
  ...SECRET_KEYS,
  "rendered_context",
  "context_text",
  "private_memory_text",
  "raw_private_memory",
  "raw_memory_text",
  "full_patch",
  "patch",
  "diff",
  "file_content",
  "raw_file_content",
  "stdout",
  "stderr",
]);

function findForbiddenKey(
  value: JsonValue,
  forbidden: ReadonlySet<string>,
  path: string[] = [],
): string[] | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenKey(value[i], forbidden, [...path, String(i)]);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    const childPath = [...path, key];
    if (forbidden.has(normalized)) return childPath;
    const found = findForbiddenKey(child, forbidden, childPath);
    if (found) return found;
  }
  return null;
}

function secretFree(schemaName: string, forbidden: ReadonlySet<string>) {
  return JsonValueSchema.superRefine((value, ctx) => {
    const path = findForbiddenKey(value, forbidden);
    if (!path) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${schemaName} forbids secret or raw-evidence field '${path.join(".")}'`,
      path,
    });
  });
}

/** JSON value that forbids nested secret-bearing keys. */
export const SecretFreeJsonSchema = secretFree("SecretFreeJson", SECRET_KEYS);
export type SecretFreeJson = z.infer<typeof SecretFreeJsonSchema>;

/**
 * JSON value safe for trace, event, step, and job metadata. In addition to
 * secret keys, it rejects fields that imply raw rendered context, private memory
 * text, full patches, raw file contents, or raw adapter logs.
 */
export const TraceSafeJsonSchema = secretFree("TraceSafeJson", TRACE_UNSAFE_KEYS);
export type TraceSafeJson = z.infer<typeof TraceSafeJsonSchema>;

export const RUN_EXECUTION_SHAPE_VALUES = [
  "conversational",
  "structured_generation",
  "agentic_files",
  "code_execution",
] as const;
export const RunExecutionShapeSchema = z.enum(RUN_EXECUTION_SHAPE_VALUES);
export type RunExecutionShape = z.infer<typeof RunExecutionShapeSchema>;

export const RunInputAttachmentSchema = z.object({
  kind: z.enum(["artifact", "source"]),
  ref_id: IdSchema,
  purpose: z.string().trim().min(1),
  locator: z.string().trim().min(1),
  media_type: z.string().trim().min(1).nullish(),
  size_bytes: z.number().int().nonnegative().nullish(),
}).strict();
export type RunInputAttachment = z.infer<typeof RunInputAttachmentSchema>;

export const RunInputProjectFolderAccessSchema = z.object({
  project_folder_id: IdSchema,
  access: z.enum(["read_only", "read_write"]),
  mount_point: z.literal("working"),
}).strict();
export type RunInputProjectFolderAccess = z.infer<
  typeof RunInputProjectFolderAccessSchema
>;

export const RunOutputDeclarationSchema = z.object({
  name: z.string().trim().min(1),
  path: z.string().trim().min(1).refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !value.split(/[\\/]+/u).includes(".."),
    "declared output path must be relative and contained",
  ),
  required: z.boolean().default(false),
  media_type: z.string().trim().min(1).nullish(),
  max_bytes: z.number().int().positive().nullish(),
  json_schema: SecretFreeJsonSchema.nullish(),
}).strict();
export type RunOutputDeclaration = z.infer<typeof RunOutputDeclarationSchema>;

export const RunOutputContractSchema = z.object({
  schema_version: z.literal("run_output_contract.v1"),
  structured_output: SecretFreeJsonSchema.nullish(),
  required_outputs: z.array(RunOutputDeclarationSchema).default([]),
}).strict();
export type RunOutputContract = z.infer<typeof RunOutputContractSchema>;

export const RunToolGrantSchema = z.object({
  action_id: z.string().trim().min(1),
  capability_id: z.string().trim().min(1).nullish(),
  approval_behavior: z.enum(["none", "pause"]),
  side_effecting: z.boolean(),
}).strict();
export type RunToolGrant = z.infer<typeof RunToolGrantSchema>;

export const RunInputEnvelopeSchema = z
  .object({
    schema_version: z.literal("run_input.v1"),
    run_id: IdSchema,
    space_id: IdSchema,
    instruction: z.string().nullish(),
    task_goal: z.string().nullish(),
    messages: z.array(CanonicalMessageSchema).default([]),
    inputs: z.object({
      direct: SecretFreeJsonSchema.nullish(),
      workflow: SecretFreeJsonSchema.nullish(),
      upstream: SecretFreeJsonSchema.nullish(),
    }).strict(),
    attachments: z.array(RunInputAttachmentSchema).default([]),
    project_folder_access: RunInputProjectFolderAccessSchema.nullish(),
    output_contract: RunOutputContractSchema,
    tool_grants: z.array(RunToolGrantSchema).default([]),
    execution: z.object({
      shape: RunExecutionShapeSchema,
      risk_level: z.string().trim().min(1).nullish(),
      required_sandbox_level: z.string().trim().min(1),
      policy_ref: z.string().trim().min(1),
      budget_ref: z.string().trim().min(1),
    }).strict(),
    ...SecretResponseGuards,
  })
  .strict()
  .superRefine((value, ctx) => {
    const path = findForbiddenKey(value as unknown as JsonValue, SECRET_KEYS);
    if (!path) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `RunInputEnvelope forbids secret field '${path.join(".")}'`,
      path,
    });
  });
export type RunInputEnvelope = z.infer<typeof RunInputEnvelopeSchema>;

export const RUNTIME_SEMANTIC_EVENT_TYPE_VALUES = [
  "assistant_message_completed",
  "tool_call_started",
  "tool_call_completed",
  "tool_call_failed",
  "approval_requested",
  "approval_resolved",
  "artifact_produced",
  "output_validation_completed",
  "provider_compacted",
  "warning",
  "error",
  "state_transition",
] as const;
export const RuntimeSemanticEventTypeSchema = z.enum(
  RUNTIME_SEMANTIC_EVENT_TYPE_VALUES,
);
export type RuntimeSemanticEventType = z.infer<
  typeof RuntimeSemanticEventTypeSchema
>;

export const RuntimeSemanticEventSchema = z.object({
  schema_version: z.literal("runtime_event.v1"),
  type: RuntimeSemanticEventTypeSchema,
  occurred_at: ISODateTimeSchema,
  call_id: z.string().trim().min(1).nullish(),
  summary: z.string().nullish(),
  metadata_json: TraceSafeJsonSchema.default({}),
}).strict();
export type RuntimeSemanticEvent = z.infer<typeof RuntimeSemanticEventSchema>;

export const RunOutputManifestItemSchema = z.object({
  name: z.string().trim().min(1),
  status: z.enum(["valid", "missing", "invalid", "oversized", "undeclared"]),
  artifact_id: IdSchema.nullish(),
  media_type: z.string().trim().min(1).nullish(),
  size_bytes: z.number().int().nonnegative().nullish(),
  validation_errors: z.array(z.string()).default([]),
}).strict();
export type RunOutputManifestItem = z.infer<typeof RunOutputManifestItemSchema>;

export const CanonicalRunOutputSchema = z
  .object({
    schema_version: z.literal("run_output.v1"),
    status: z.enum(["succeeded", "rejected", "failed"]),
    summary: z.string().default(""),
    result: SecretFreeJsonSchema.nullish(),
    output_manifest: z.array(RunOutputManifestItemSchema).default([]),
    ...SecretResponseGuards,
  })
  .strict()
  .superRefine((value, ctx) => {
    const path = findForbiddenKey(value as unknown as JsonValue, SECRET_KEYS);
    if (!path) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `CanonicalRunOutput forbids secret field '${path.join(".")}'`,
      path,
    });
  });
export type CanonicalRunOutput = z.infer<typeof CanonicalRunOutputSchema>;

export const RUN_STATUS_VALUES = [
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "degraded",
  "cancelled",
  "orphaned",
  "waiting_for_review",
  "waiting_for_dependency",
] as const;
export const RunStatusSchema = z.enum(RUN_STATUS_VALUES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RUN_TERMINAL_STATUS_VALUES = [
  "succeeded",
  "failed",
  "degraded",
  "cancelled",
  "orphaned",
] as const;
export const RunTerminalStatusSchema = z.enum(RUN_TERMINAL_STATUS_VALUES);
export type RunTerminalStatus = z.infer<typeof RunTerminalStatusSchema>;

export const RUN_EVENT_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "warning",
  "cancelled",
] as const;
export const RunEventStatusSchema = z.enum(RUN_EVENT_STATUS_VALUES);
export type RunEventStatus = z.infer<typeof RunEventStatusSchema>;

export const RUN_EXECUTION_ERROR_CODES = [
  "adapter_nonzero_exit",
  "adapter_timeout",
  "cli_stall_timeout",
  "code_patch_collection_error",
  "context_render_failed",
  "credential_metadata_missing",
  "duplicate_execution",
  "file_access_adapter_requires_worktree_policy",
  "missing_runtime_credential",
  "policy_denied_runtime_execute",
  "policy_denied_runtime_use_credential",
  "policy_requires_approval_runtime_execute",
  "policy_requires_approval_runtime_use_credential",
  "produced_artifact_ingestion_error",
  "run_cancelled",
  "run_abandoned",
  "cancel_confirmation_timeout",
  "orphaned",
  "runtime_removed",
  "runtime_tool_version_unavailable",
  "runtime_session_invalid",
  "runtime_tools_not_implemented",
  "sandbox_creation_failed",
  "stale_run_recovered",
] as const;
export const RunExecutionKnownErrorCodeSchema = z.enum(RUN_EXECUTION_ERROR_CODES);
export type RunExecutionKnownErrorCode = z.infer<
  typeof RunExecutionKnownErrorCodeSchema
>;

export const RunExecutionErrorCodeSchema = z.string().min(1);
export type RunExecutionErrorCode = z.infer<typeof RunExecutionErrorCodeSchema>;

export const RunExecutionCommandSourceSchema = z.enum([
  "http",
  "job",
  "recovery",
  "internal",
]);
export type RunExecutionCommandSource = z.infer<
  typeof RunExecutionCommandSourceSchema
>;

export const RunExecuteRequestSchema = z.object({
  run_id: IdSchema,
  space_id: IdSchema,
  runtime: z.string().nullish(),
  worker_id: z.string().min(1),
  job_id: IdSchema.nullish(),
  command_source: RunExecutionCommandSourceSchema.default("http"),
  simulate_failure: z.boolean().optional(),
});
export type RunExecuteRequest = z.infer<typeof RunExecuteRequestSchema>;

export const RunCancelRequestSchema = z.object({
  run_id: IdSchema,
  space_id: IdSchema,
  requested_by_user_id: IdSchema.nullish(),
  reason: z.string().nullish(),
  terminate_process: z.boolean().default(true),
});
export type RunCancelRequest = z.infer<typeof RunCancelRequestSchema>;

export const RunAdapterKindSchema = z.enum([
  "native",
  "managed_api",
  "local_cli",
  "custom",
]);
export type RunAdapterKind = z.infer<typeof RunAdapterKindSchema>;

export const RunAdapterResultEnvelopeSchema = z
  .object({
    adapter_type: z.string().min(1),
    adapter_kind: RunAdapterKindSchema,
    success: z.boolean(),
    output_text: z.string().default(""),
    output_json: SecretFreeJsonSchema.nullish(),
    exit_code: z.number().int().nullable(),
    error_code: RunExecutionErrorCodeSchema.nullish(),
    error_message: z.string().nullish(),
    started_at: ISODateTimeSchema.nullish(),
    completed_at: ISODateTimeSchema.nullish(),
    usage: CanonicalUsageSchema.nullish(),
    model_usage: z.array(CanonicalModelUsageSchema).optional(),
    metadata_json: TraceSafeJsonSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RunAdapterResultEnvelope = z.infer<
  typeof RunAdapterResultEnvelopeSchema
>;

export const RunMaterializationItemSummarySchema = z
  .object({
    kind: z.enum(["artifact", "proposal", "activity", "code_patch", "delegation"]),
    status: z.enum(["succeeded", "failed", "warning", "skipped"]),
    artifact_id: IdSchema.nullish(),
    proposal_id: IdSchema.nullish(),
    activity_id: IdSchema.nullish(),
    error_code: RunExecutionErrorCodeSchema.nullish(),
    error_message: z.string().nullish(),
    metadata_json: TraceSafeJsonSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RunMaterializationItemSummary = z.infer<
  typeof RunMaterializationItemSummarySchema
>;

export const RunTerminalResultSchema = z
  .object({
    run_id: IdSchema,
    space_id: IdSchema,
    status: RunTerminalStatusSchema,
    output_text: z.string().default(""),
    output_json: SecretFreeJsonSchema.nullish(),
    error_json: TraceSafeJsonSchema.nullish(),
    exit_code: z.number().int().nullable(),
    started_at: ISODateTimeSchema.nullish(),
    completed_at: ISODateTimeSchema,
    adapter_result: RunAdapterResultEnvelopeSchema.nullish(),
    materialization: z.array(RunMaterializationItemSummarySchema).default([]),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RunTerminalResult = z.infer<typeof RunTerminalResultSchema>;

export const RunEventAppendRequestSchema = z
  .object({
    run_id: IdSchema,
    space_id: IdSchema,
    event_type: z.string().min(1),
    status: RunEventStatusSchema,
    step_id: IdSchema.nullish(),
    actor_id: IdSchema.nullish(),
    summary: z.string().nullish(),
    metadata_json: TraceSafeJsonSchema.default({}),
    error_code: RunExecutionErrorCodeSchema.nullish(),
    error_message: z.string().nullish(),
    artifact_id: IdSchema.nullish(),
    proposal_id: IdSchema.nullish(),
    project_folder_id: IdSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RunEventAppendRequest = z.infer<typeof RunEventAppendRequestSchema>;

export const RunJobPayloadSchema = z
  .object({
    space_id: IdSchema.nullish(),
    user_id: IdSchema.nullish(),
    run_id: IdSchema.nullish(),
    task_id: IdSchema.nullish(),
    agent_id: IdSchema.nullish(),
    runtime: z.string().nullish(),
    simulate_failure: z.boolean().optional(),
    mode: z.string().nullish(),
    run_type: z.string().nullish(),
    trigger_origin: RunTriggerOriginSchema.nullish(),
    session_id: IdSchema.nullish(),
    project_folder_id: IdSchema.nullish(),
    project_id: IdSchema.nullish(),
    prompt: z.string().nullish(),
    instruction: z.string().nullish(),
    set_task_in_progress: z.boolean().optional(),
    parent_run_id: IdSchema.nullish(),
    root_run_id: IdSchema.nullish(),
    run_group_id: IdSchema.nullish(),
    delegation_id: IdSchema.nullish(),
    instructed_by_agent_id: IdSchema.nullish(),
    adapter_type: z.string().nullish(),
  })
  .refine(
    (value) => Boolean(value.run_id || value.task_id || value.agent_id),
    "agent_run payload requires run_id, task_id, or agent_id",
  );
export type RunJobPayload = z.infer<typeof RunJobPayloadSchema>;

export const RunJobEnvelopeSchema = z.object({
  job_id: IdSchema,
  space_id: IdSchema,
  user_id: IdSchema,
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  worker_id: z.string().min(1).nullish(),
  payload: RunJobPayloadSchema,
});
export type RunJobEnvelope = z.infer<typeof RunJobEnvelopeSchema>;

export const RunJobResultSchema = z
  .object({
    run_id: IdSchema,
    status: RunStatusSchema.or(z.literal("unknown")),
    skipped: z.boolean().optional(),
    skip_reason: z.string().nullish(),
    error_code: RunExecutionErrorCodeSchema.nullish(),
    error_text: z.string().nullish(),
    error: z.string().nullish(),
    metadata_json: TraceSafeJsonSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RunJobResult = z.infer<typeof RunJobResultSchema>;

export const RunTraceEventSummarySchema = z
  .object({
    event_type: z.string().min(1),
    status: RunEventStatusSchema,
    summary: z.string().nullish(),
    error_code: RunExecutionErrorCodeSchema.nullish(),
    metadata_json: TraceSafeJsonSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RunTraceEventSummary = z.infer<typeof RunTraceEventSummarySchema>;

export const RunTraceSafeSummarySchema = z
  .object({
    run_id: IdSchema,
    space_id: IdSchema,
    status: RunStatusSchema,
    adapter_type: z.string().nullish(),
    model_provider_id: IdSchema.nullish(),
    required_sandbox_level: z.string().nullish(),
    parent_run_id: IdSchema.nullish(),
    root_run_id: IdSchema.nullish(),
    run_group_id: IdSchema.nullish(),
    delegation_id: IdSchema.nullish(),
    instructed_by_agent_id: IdSchema.nullish(),
    started_at: ISODateTimeSchema.nullish(),
    completed_at: ISODateTimeSchema.nullish(),
    error_code: RunExecutionErrorCodeSchema.nullish(),
    event_summaries: z.array(RunTraceEventSummarySchema).default([]),
    artifact_summaries: z
      .array(
        z
          .object({
            artifact_id: IdSchema,
            artifact_type: z.string().min(1),
            title: z.string().nullish(),
            ...SecretResponseGuards,
          })
          .passthrough(),
      )
      .default([]),
    proposal_summaries: z
      .array(
        z
          .object({
            proposal_id: IdSchema,
            proposal_type: z.string().min(1),
            status: z.string().min(1),
            ...SecretResponseGuards,
          })
          .passthrough(),
      )
      .default([]),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RunTraceSafeSummary = z.infer<typeof RunTraceSafeSummarySchema>;
