/**
 * Provider and credential runtime contracts.
 *
 * These schemas describe the durable boundary between provider commands,
 * provider-key resolution, CLI credential brokering, and internal runtime
 * callers. The protocol package owns schemas and types only.
 */

import { z } from "zod";
import { IdSchema, RunTriggerOriginSchema, SecretResponseGuards } from "./common.js";

export const ProviderCredentialsAuthoritySchema = z.enum(["server"]);

export const ProviderCompletionInternalRequestSchema = z.object({
  space_id: IdSchema,
  provider_id: IdSchema,
  model: z.string().nullish(),
  system: z.string().default(""),
  user: z.string(),
  max_tokens: z.number().int().positive().optional(),
  /**
   * Auxiliary-task name (for example, a retrieval or checkpoint extractor). When the space has a
   * ProviderTaskPolicy for this task, its chain takes precedence over
   * `provider_id`, which then acts as the safety-net provider.
   */
  task: z.string().nullish(),
  subject_user_id: IdSchema.nullish(),
  source_resource_type: z.string().min(1).nullish(),
  source_resource_id: IdSchema.nullish(),
  space_system_task: z.boolean().optional(),
  meter_subject_type: z.string().min(1).nullish(),
  meter_subject_id: z.string().min(1).nullish(),
}).superRefine((value, ctx) => {
  const hasSourceType = Boolean(value.source_resource_type);
  const hasSourceId = Boolean(value.source_resource_id);
  if (hasSourceType !== hasSourceId) {
    ctx.addIssue({ code: "custom", message: "source_resource_type and source_resource_id must be provided together" });
  }
  const isSpaceSystemTask = value.space_system_task === true &&
    value.meter_subject_type === "space_system" && Boolean(value.meter_subject_id);
  if (!value.subject_user_id && !(hasSourceType && hasSourceId) && !isSpaceSystemTask) {
    ctx.addIssue({
      code: "custom",
      message: "subject_user_id, a source resource, or an explicit Space system subject is required",
    });
  }
});

export const ProviderCompletionInternalResponseSchema = z
  .object({
    text: z.string(),
    model: z.string(),
    usage: z.record(z.unknown()).nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();

export const RuntimeCredentialResolveRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model_provider_api_key"),
    space_id: IdSchema,
    provider_id: IdSchema,
  }),
  z.object({
    kind: z.literal("credential_api_key"),
    space_id: IdSchema,
    credential_id: IdSchema,
  }),
  z.object({
    kind: z.literal("cli_profile"),
    space_id: IdSchema.optional(),
    runtime: z.string().min(1),
    profile_id: z.string().nullish(),
    require_existing: z.boolean().optional(),
    user_id: IdSchema,
  }),
]);

export const RuntimeCredentialResolveResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model_provider_api_key"),
    provider_id: IdSchema,
    api_key: z.string().min(1),
  }),
  z.object({
    kind: z.literal("credential_api_key"),
    credential_id: IdSchema,
    api_key: z.string().min(1),
  }),
  z.object({
    kind: z.literal("cli_profile"),
    profile_id: z.string(),
    runtime: z.string(),
    source_path: z.string(),
    target_path: z.string(),
    readonly: z.boolean(),
  }),
]);

export const CliCredentialGrantRequestSchema = z.object({
  run_id: z.string().min(1),
  space_id: IdSchema,
  runtime: z.string().min(1),
  risk_level: z.string().min(1),
  executor_mode: z.enum(["worktree", "docker"]),
  profile_id: z.string().nullish(),
  user_id: IdSchema,
});

export const CliCredentialGrantResponseSchema = z
  .object({
    granted: z.boolean(),
    profile_id: z.string().nullish(),
    runtime: z.string(),
    executor_mode: z.enum(["worktree", "docker"]),
    readonly: z.boolean(),
    temp_home: z.string().nullish(),
    host_source_path: z.string().nullish(),
    target_path: z.string().nullish(),
    env: z.record(z.string()),
    fallback_reason: z.string().nullish(),
  })
  .passthrough();

export const CliCredentialAuditRequestSchema = z.object({
  space_id: IdSchema,
  run_id: z.string().nullish(),
  runtime_adapter_type: z.string().nullish(),
  credential_profile_id: z.string().nullish(),
  trigger_origin: RunTriggerOriginSchema.nullish(),
  fallback_used: z.boolean().optional(),
  fallback_reason: z.string().nullish(),
  broker_error: z.boolean().optional(),
  cleanup_status: z.string().optional(),
  action: z.string().optional(),
});

export const CliCredentialAuditResponseSchema = z
  .object({
    status: z.literal("recorded"),
    event_id: IdSchema,
    ...SecretResponseGuards,
  })
  .passthrough();

export const ProviderResilienceFailureClassSchema = z.enum([
  "rate_limit",
  "payment_required",
  "unauthorized",
  "quota_exhausted",
  "transient",
  "permanent",
]);

export const ProviderResilienceActionSchema = z.enum([
  "retry_same_key_once",
  "rotate_key",
  "cooldown_24h",
  "refresh_token",
  "fallback_provider",
  "fail",
]);
export type ProviderResilienceAction = z.infer<typeof ProviderResilienceActionSchema>;

export const ProviderResilienceDecisionSchema = z.object({
  failure_class: ProviderResilienceFailureClassSchema,
  actions: z.array(ProviderResilienceActionSchema).min(1),
  cooldown_seconds: z.number().int().nonnegative().optional(),
});
export type ProviderResilienceDecision = z.infer<
  typeof ProviderResilienceDecisionSchema
>;

// ---------------------------------------------------------------------------
// Credential pools and per-task provider chains.
// ---------------------------------------------------------------------------

export const ProviderRotationStrategySchema = z.enum([
  "fill_first",
  "round_robin",
  "least_used",
  "random",
]);

/**
 * Pool membership + health state for one credential. Secret-free: the
 * encrypted material stays in `credentials.secret_ref` server-side.
 */
export const ProviderPoolMemberDTOSchema = z
  .object({
    id: IdSchema,
    credential_id: IdSchema,
    name: z.string(),
    position: z.number().int(),
    enabled: z.boolean(),
    healthy: z.boolean(),
    cooldown_until: z.string().nullish(),
    last_failure_class: ProviderResilienceFailureClassSchema.nullish(),
    request_count: z.number().int().nonnegative(),
    failure_count: z.number().int().nonnegative(),
    last_used_at: z.string().nullish(),
    created_at: z.string(),
    updated_at: z.string(),
    ...SecretResponseGuards,
  })
  .passthrough();

export const ProviderPoolResponseSchema = z
  .object({
    provider_id: IdSchema,
    rotation_strategy: ProviderRotationStrategySchema,
    fallback_provider_ids: z.array(IdSchema),
    members: z.array(ProviderPoolMemberDTOSchema),
    ...SecretResponseGuards,
  })
  .passthrough();

/** `api_key` is request-only secret material; it never appears in responses. */
export const ProviderPoolCredentialAddRequestSchema = z.object({
  api_key: z.string().min(1),
  name: z.string().min(1).optional(),
  position: z.number().int().optional(),
});

export const ProviderPoolConfigUpdateRequestSchema = z.object({
  rotation_strategy: ProviderRotationStrategySchema.optional(),
  fallback_provider_ids: z.array(IdSchema).optional(),
});

export const ProviderTaskChainEntrySchema = z.object({
  provider_id: IdSchema,
  model: z.string().nullish(),
});
export type ProviderTaskChainEntry = z.infer<typeof ProviderTaskChainEntrySchema>;

export const ProviderTaskPolicyDTOSchema = z
  .object({
    task: z.string().min(1),
    chain: z.array(ProviderTaskChainEntrySchema),
    enabled: z.boolean(),
    updated_at: z.string(),
    ...SecretResponseGuards,
  })
  .passthrough();

export const ProviderTaskPolicyPutRequestSchema = z.object({
  chain: z.array(ProviderTaskChainEntrySchema).min(1),
  enabled: z.boolean().optional(),
});
export type ProviderTaskPolicyPutRequest = z.infer<
  typeof ProviderTaskPolicyPutRequestSchema
>;
