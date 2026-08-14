/**
 * Runtime-host contracts.
 *
 * These schemas describe the internal boundary used when run orchestration
 * invokes the managed API runtime host as an adapter implementation. The host
 * may execute provider-backed model turns; it does not own run lifecycle,
 * persistence, orchestration, or a self-hosted agent loop.
 */

import { z } from "zod";
import { InvocationAuditRefsSchema } from "./runtimeContext.js";
import { IdSchema, ISODateTimeSchema, RunTriggerOriginSchema, SecretResponseGuards } from "./common.js";
import {
  CanonicalMessageSchema,
  CanonicalToolDefinitionSchema,
  CanonicalModelEventSchema,
  CanonicalUsageSchema,
} from "./model.js";
import { RunInputEnvelopeSchema } from "./runOrchestration.js";

export const RuntimeHostToolModeSchema = z.enum(["disabled", "authorized_bindings"]);

export const RuntimeHostToolBindingSchema = z
  .object({
    id: IdSchema,
    external_type: z.string().min(1),
    external_ref: z.string().min(1),
    display_name: z.string().min(1),
    required_scopes: z.array(z.string()).optional(),
    credential_ref: z.string().nullish(),
    data_exposure_level: z.string().min(1),
    observability_level: z.string().min(1),
    side_effect_level: z.string().min(1),
    approval_required: z.boolean(),
    ...SecretResponseGuards,
  })
  .passthrough();

export const RuntimeHostStructuredOutputSchema = z.object({
  type: z.literal("json_schema"),
  schema_id: z.string().trim().min(1),
  schema: z.record(z.unknown()),
  strict: z.boolean().default(true),
  stage: z.string().trim().min(1).optional(),
});

export const RuntimeHostExecuteRequestSchema = z.object({
  run_input: RunInputEnvelopeSchema,
  run_id: IdSchema,
  space_id: IdSchema,
  subject_user_id: IdSchema.nullish(),
  model_provider_id: IdSchema,
  model: z.string().nullish(),
  system_prompt: z.string().nullish(),
  prompt: z.string(),
  messages: z.array(CanonicalMessageSchema).min(1).optional(),
  mode: z.string().min(1),
  instruction: z.string().nullish(),
  session_id: IdSchema.nullish(),
  parent_run_id: IdSchema.nullish(),
  root_run_id: IdSchema.nullish(),
  run_group_id: IdSchema.nullish(),
  agent_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  project_folder_id: IdSchema.nullish(),
  trigger_origin: RunTriggerOriginSchema.nullish(),
  capability_id: z.string().nullish(),
  max_tokens: z.number().int().positive().optional(),
  output_format: RuntimeHostStructuredOutputSchema.nullish(),
  tool_mode: RuntimeHostToolModeSchema.default("disabled"),
  tool_bindings: z.array(RuntimeHostToolBindingSchema).default([]),
  tools: z.array(CanonicalToolDefinitionSchema).optional(),
  cache_strategy: z.literal("conversation").optional(),
  invocation_audit_refs: InvocationAuditRefsSchema.optional(),
});
export type RuntimeHostExecuteRequest = z.infer<typeof RuntimeHostExecuteRequestSchema>;

export const RuntimeHostExecuteResponseSchema = z
  .object({
    success: z.boolean(),
    stdout: z.string().default(""),
    stderr: z.string().default(""),
    output_text: z.string().default(""),
    output_json: z.record(z.unknown()).nullish(),
    exit_code: z.number().int().nullable(),
    error_text: z.string().nullish(),
    error_code: z.string().nullish(),
    started_at: ISODateTimeSchema.nullish(),
    completed_at: ISODateTimeSchema.nullish(),
    model: z.string().nullish(),
    usage: CanonicalUsageSchema.nullish(),
    events: z.array(CanonicalModelEventSchema).default([]),
    adapter_metadata: z.record(z.unknown()).nullish(),
    adapter_log_json: z.record(z.unknown()).nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type RuntimeHostExecuteResponse = z.infer<typeof RuntimeHostExecuteResponseSchema>;
