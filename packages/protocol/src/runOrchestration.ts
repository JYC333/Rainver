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
  SecretResponseGuards,
} from "./common.js";
import {
  CanonicalMessageSchema,
  CanonicalModelUsageSchema,
  CanonicalUsageSchema,
} from "./model.js";
import {
  findSecretFieldPath,
  SecretFreeJsonSchema,
  TraceSafeJsonSchema,
  type JsonValue,
} from "./jsonSafety.js";
import { RuntimeKeySchema } from "./runtimeAuthority.js";
export {
  SecretFreeJsonRecordSchema,
  SecretFreeJsonSchema,
  stripSecretFields,
  stripSecretFieldsFromRecord,
  TraceSafeJsonSchema,
} from "./jsonSafety.js";
export type { JsonValue, SecretFreeJson, TraceSafeJson } from "./jsonSafety.js";

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
    const path = findSecretFieldPath(value as unknown as JsonValue);
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
    const path = findSecretFieldPath(value as unknown as JsonValue);
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

/**
 * Codes a Run's failure is known to carry. Descriptive, not a gate:
 * `RunExecutionErrorCodeSchema` below accepts any non-empty string, and
 * historical rows keep whatever they were written with.
 *
 * Pruned 2026-09-08 with ADR 0016's unified host: `cli_stall_timeout`,
 * `credential_metadata_missing`, `missing_runtime_credential`,
 * `runtime_tool_version_unavailable` and `sandbox_creation_failed` all
 * belonged to the deleted server-side CLI line — the credential broker, the
 * runtime-tool catalog and the server-owned sandbox. Their remote twins
 * (`runtime_stall_timeout`, `runtime_removed`) carry those failures now.
 */
export const RUN_EXECUTION_ERROR_CODES = [
  "adapter_nonzero_exit",
  "adapter_timeout",
  "code_patch_collection_error",
  "context_render_failed",
  "duplicate_execution",
  "file_access_adapter_requires_worktree_policy",
  "policy_denied_runtime_execute",
  "policy_denied_runtime_use_credential",
  "policy_requires_approval_runtime_execute",
  "produced_artifact_ingestion_error",
  "run_cancelled",
  "run_abandoned",
  "cancel_confirmation_timeout",
  "orphaned",
  "runtime_removed",
  "runtime_session_invalid",
  "runtime_tools_not_implemented",
  "stale_run_recovered",
] as const;
export const RunExecutionKnownErrorCodeSchema = z.enum(RUN_EXECUTION_ERROR_CODES);

export const RunExecutionErrorCodeSchema = z.string().min(1);

export const RunExecutionCommandSourceSchema = z.enum([
  "http",
  "job",
  "recovery",
  "internal",
]);

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

export const RunAdapterKindSchema = z.enum([
  "native",
  "managed_api",
  "local_cli",
  "custom",
]);

export const RunAdapterResultEnvelopeSchema = z
  .object({
    runtime_key: RuntimeKeySchema,
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
