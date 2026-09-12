/**
 * Provider and credential runtime contracts.
 *
 * These schemas describe the durable boundary between provider commands,
 * provider-key resolution, and internal runtime callers. No CLI credential is
 * brokered (ADR 0016). The protocol package owns schemas and types only.
 */

import { z } from "zod";
import { IdSchema, SecretResponseGuards } from "./common.js";

export const ProviderCredentialsAuthoritySchema = z.enum(["server"]);

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
