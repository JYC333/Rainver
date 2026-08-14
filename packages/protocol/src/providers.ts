/**
 * Provider and model-provider credential-channel contracts.
 *
 * These schemas mirror the public provider API and make the credential boundary
 * explicit. They are contracts only: no provider
 * client, no secret storage, no credential release, no transport, no authority.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

export const PROVIDER_TYPE_VALUES = [
  "openai",
  "openai_codex",
  "anthropic",
  "minimax",
  "openrouter",
  "deepseek",
  "ollama",
  "zeroentropy",
  "cohere",
  "openai_compatible",
] as const;
export type ProviderTypeValue = (typeof PROVIDER_TYPE_VALUES)[number];
export function isProviderType(value: string): value is ProviderTypeValue {
  return (PROVIDER_TYPE_VALUES as readonly string[]).includes(value);
}

export const CREDENTIAL_CHANNEL_VALUES = [
  "model_provider_api_key",
  "managed_subscription_oauth",
  "cli_login_state",
] as const;
export type CredentialChannelValue = (typeof CREDENTIAL_CHANNEL_VALUES)[number];
export function isCredentialChannel(value: string): value is CredentialChannelValue {
  return (CREDENTIAL_CHANNEL_VALUES as readonly string[]).includes(value);
}

/** Model provider response DTO; response-only and secret-free. */
export const ModelProviderDTOSchema = z
  .object({
    id: IdSchema,
    /** Effective active space for this response. */
    space_id: IdSchema,
    /** Home/creation space of the provider row. */
    home_space_id: IdSchema.nullish(),
    owner_user_id: IdSchema.nullish(),
    grant_id: IdSchema.nullish(),
    name: z.string(),
    provider_type: z.string(),
    base_url: z.string(),
    network_profile_id: IdSchema.nullish(),
    claude_compatible_base_url: z.string().nullish(),
    openai_compatible_base_url: z.string().nullish(),
    default_model: z.string().nullish(),
    available_models: z.array(z.string()),
    enabled: z.boolean(),
    is_default: z.boolean(),
    has_api_key: z.boolean(),
    has_subscription: z.boolean().optional(),
    subscription_type: z.enum(["anthropic", "openai_codex"]).nullish(),
    subscription_quota: z.object({
      available: z.boolean(),
      session_pct: z.number().nullish(),
      session_resets: z.string().nullish(),
      week_pct: z.number().nullish(),
      week_resets: z.string().nullish(),
      checked_at: z.string().nullish(),
      error: z.string().nullish(),
    }).nullish().optional(),
    manageable: z.boolean().optional(),
    grant_enabled: z.boolean().optional(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type ModelProviderDTO = z.infer<typeof ModelProviderDTOSchema>;

/**
 * Request body for creating or replacing a ModelProvider. `api_key` is
 * request-only secret material and must never appear in `ModelProviderDTO`.
 */
export const ModelProviderCreateRequestSchema = z.object({
  name: z.string().min(1),
  provider_type: z.string().min(1),
  base_url: z.string().min(1),
  network_profile_id: IdSchema.nullish(),
  claude_compatible_base_url: z.string().nullish(),
  openai_compatible_base_url: z.string().nullish(),
  api_key: z.string().nullish(),
  default_model: z.string().nullish(),
  available_models: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

/** Request body for patching a ModelProvider. All fields are optional. */
export const ModelProviderUpdateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  provider_type: z.string().min(1).optional(),
  base_url: z.string().min(1).optional(),
  network_profile_id: IdSchema.nullish(),
  claude_compatible_base_url: z.string().nullish(),
  openai_compatible_base_url: z.string().nullish(),
  api_key: z.string().nullish(),
  default_model: z.string().nullish(),
  available_models: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

export const ModelProviderSpaceGrantRequestSchema = z.object({
  space_id: IdSchema,
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
  network_profile_id: IdSchema.nullish(),
});

export const ModelProviderSpaceGrantDTOSchema = z
  .object({
    id: IdSchema,
    provider_id: IdSchema,
    space_id: IdSchema,
    owner_user_id: IdSchema.nullish(),
    granted_by_user_id: IdSchema.nullish(),
    enabled: z.boolean(),
    is_default: z.boolean(),
    network_profile_id: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();

export const ModelProviderModelsResponseSchema = z.object({
  models: z.array(z.string()),
  source: z.union([z.literal("configured"), z.literal("live")]),
});

/** `GET /providers/catalog` response; static, secret-free. */
export const ProviderCatalogInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    model_hint: z.string(),
    supported_params: z.array(z.string()),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ProviderCatalogInfo = z.infer<typeof ProviderCatalogInfoSchema>;

/** `GET /providers/litellm-providers`: litellm chat provider ids. */
export const LitellmProvidersResponseSchema = z.array(z.string());

export const ProviderPresetModeSchema = z.enum(["chat", "embedding", "rerank"]);
export type ProviderPresetMode = z.infer<typeof ProviderPresetModeSchema>;

export const ProviderPresetDTOSchema = z
  .object({
    id: z.string().min(1),
    mode: ProviderPresetModeSchema,
    label: z.string().min(1),
    description: z.string().nullish(),
    name: z.string().min(1),
    provider_type: z.enum(PROVIDER_TYPE_VALUES),
    base_url: z.string().min(1),
    claude_compatible_base_url: z.string().nullish(),
    openai_compatible_base_url: z.string().nullish(),
    default_model: z.string().nullish(),
    available_models: z.array(z.string()),
    embedding_dimensions: z.number().int().positive().nullish(),
    embedding_dimension_options: z.array(z.number().int().positive()).optional(),
    api_key_required: z.boolean(),
    task: z.string().nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type ProviderPresetDTO = z.infer<typeof ProviderPresetDTOSchema>;

export const ProviderPresetListResponseSchema = z.array(ProviderPresetDTOSchema);

export const ProviderFromPresetCreateRequestSchema = z.object({
  preset_id: z.string().min(1),
  api_key: z.string().nullish(),
  name: z.string().min(1).optional(),
  network_profile_id: IdSchema.nullish(),
  default_model: z.string().nullish(),
  available_models: z.array(z.string()).optional(),
  embedding_dimensions: z.number().int().min(64).max(4096).optional(),
  is_default: z.boolean().optional(),
});
export type ProviderFromPresetCreateRequest = z.infer<
  typeof ProviderFromPresetCreateRequestSchema
>;

export const ProviderFromPresetCreateResponseSchema = z.object({
  provider: ModelProviderDTOSchema,
});
export type ProviderFromPresetCreateResponse = z.infer<
  typeof ProviderFromPresetCreateResponseSchema
>;

/**
 * The catalog payload itself. Pinned by exact value on
 * both sides. The provider authority serves this constant for the public
 * catalog route.
 */
export const PROVIDER_CATALOG_INFO: ProviderCatalogInfo = {
  id: "litellm",
  name: "LiteLLM (Open Format)",
  description:
    "Configure OpenAI-compatible, Anthropic-compatible, OpenRouter, Ollama, or other endpoints.",
  model_hint: "Set default_model and/or available_models on the provider",
  supported_params: ["model", "temperature", "max_tokens", "system"],
};

export const ProviderConnectionTestResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  model: z.string().nullish(),
});

export const ManagedSubscriptionTypeSchema = z.enum(["anthropic", "openai_codex"]);
export type ManagedSubscriptionType = z.infer<typeof ManagedSubscriptionTypeSchema>;

export const ManagedSubscriptionLoginInputSchema = z.object({
  input: z.string().min(1),
});

export const ManagedSubscriptionQuotaSchema = z.object({
  available: z.boolean(),
  session_pct: z.number().nullish(),
  session_resets: z.string().nullish(),
  week_pct: z.number().nullish(),
  week_resets: z.string().nullish(),
  checked_at: z.string().nullish(),
  error: z.string().nullish(),
});

export const ProviderChatMessageSchema = z.object({
  role: z.string().min(1),
  content: z.string(),
});

/**
 * Public credential-channel metadata. This is not a secret carrier and does not
 * model the encrypted `Credential.secret_ref` value.
 */
export const CredentialChannelMetadataSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("model_provider_api_key"),
    pooled: z.boolean(),
    rotated: z.boolean(),
  }),
  z.object({
    channel: z.literal("managed_subscription_oauth"),
    pooled: z.literal(false),
    rotated: z.literal(false),
    owner_bound: z.literal(true),
  }),
  z.object({
    channel: z.literal("cli_login_state"),
    pooled: z.literal(false),
    rotated: z.literal(false),
  }),
]);
