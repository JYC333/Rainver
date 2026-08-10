import { describe, it, expect, expectTypeOf } from "vitest";
import {
  CredentialChannelMetadataSchema,
  LitellmProvidersResponseSchema,
  ModelProviderCreateRequestSchema,
  ModelProviderDTOSchema,
  ModelProviderModelsResponseSchema,
  ModelProviderUpdateRequestSchema,
  ProviderCatalogInfoSchema,
  ProviderConnectionTestResultSchema,
  ProviderFromPresetCreateRequestSchema,
  ProviderPresetDTOSchema,
  isCredentialChannel,
  isProviderType,
  type ModelProviderDTO,
} from "../src/index";

describe("provider contracts", () => {
  it("parses the current public ModelProviderOut shape", () => {
    const parsed = ModelProviderDTOSchema.parse({
      id: "mp1",
      space_id: "s1",
      name: "Main",
      provider_type: "anthropic",
      base_url: "https://api.anthropic.com",
      claude_compatible_base_url: "https://api.example.test/anthropic",
      openai_compatible_base_url: null,
      default_model: "claude-sonnet-4-6",
      available_models: ["claude-sonnet-4-6"],
      enabled: true,
      is_default: true,
      has_api_key: true,
      created_at: "2026-06-11T12:00:00+00:00",
      updated_at: "2026-06-11T12:00:00+00:00",
    });
    expect(parsed.provider_type).toBe("anthropic");
    expect(parsed.claude_compatible_base_url).toBe("https://api.example.test/anthropic");
    expect(parsed.has_api_key).toBe(true);
  });

  it("rejects secret material in provider response contracts", () => {
    const base = {
      id: "mp1",
      space_id: "s1",
      name: "Main",
      provider_type: "openai",
      base_url: "https://api.openai.com/v1",
      claude_compatible_base_url: null,
      openai_compatible_base_url: "https://api.openai.com/v1",
      default_model: "gpt-4o",
      available_models: [],
      enabled: true,
      is_default: false,
      has_api_key: true,
      created_at: "2026-06-11T12:00:00+00:00",
      updated_at: "2026-06-11T12:00:00+00:00",
    };
    expect(ModelProviderDTOSchema.safeParse({ ...base, api_key: "sk-live" }).success).toBe(
      false,
    );
    expect(
      ModelProviderDTOSchema.safeParse({ ...base, secret_ref: "model_provider_api_key:v1:x" })
        .success,
    ).toBe(false);
  });

  it("allows request-only api_key on create/update payloads", () => {
    expect(
      ModelProviderCreateRequestSchema.parse({
        name: "Main",
        provider_type: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-test",
        claude_compatible_base_url: "https://api.example.test/anthropic",
        openai_compatible_base_url: "https://api.example.test/v1",
        default_model: "gpt-4o",
      }).api_key,
    ).toBe("sk-test");

    expect(
      ModelProviderCreateRequestSchema.parse({
        name: "Claude Gateway",
        provider_type: "other",
        base_url: "https://api.example.test/v1",
        claude_compatible_base_url: "https://api.example.test/anthropic",
      }).claude_compatible_base_url,
    ).toBe("https://api.example.test/anthropic");

    expect(ModelProviderUpdateRequestSchema.parse({ api_key: "sk-new" }).api_key).toBe(
      "sk-new",
    );
    expect(
      ModelProviderUpdateRequestSchema.parse({ claude_compatible_base_url: null })
        .claude_compatible_base_url,
    ).toBeNull();
    expect(
      ModelProviderUpdateRequestSchema.parse({ openai_compatible_base_url: null })
        .openai_compatible_base_url,
    ).toBeNull();
    expect(ModelProviderCreateRequestSchema.safeParse({
      name: "Missing URL",
      provider_type: "openai",
      api_key: "sk-test",
    }).success).toBe(false);
  });

  it("parses provider support responses and chat request/response bodies", () => {
    expect(
      ModelProviderModelsResponseSchema.parse({
        models: ["gpt-4o"],
        source: "configured",
      }).source,
    ).toBe("configured");
    expect(
      ProviderConnectionTestResultSchema.parse({
        success: true,
        message: "ok",
        model: "gpt-4o",
      }).success,
    ).toBe(true);
  });

  it("parses the static catalog and litellm-providers read shapes", () => {
    const catalogInfo = {
      id: "litellm",
      name: "LiteLLM (Open Format)",
      description: "Configure endpoints.",
      model_hint: "Set default_model",
      supported_params: ["model", "temperature"],
    };
    expect(ProviderCatalogInfoSchema.parse(catalogInfo).id).toBe("litellm");
    expect(
      ProviderCatalogInfoSchema.safeParse({ ...catalogInfo, api_key: "sk-leak" }).success,
    ).toBe(false);
    expect(LitellmProvidersResponseSchema.parse(["openai", "anthropic"])).toHaveLength(2);
    expect(LitellmProvidersResponseSchema.safeParse([{ id: "openai" }]).success).toBe(false);
  });

  it("parses provider preset catalog entries and create-from-preset requests", () => {
    expect(
      ProviderPresetDTOSchema.parse({
        id: "cohere_embedding",
        mode: "embedding",
        label: "Cohere Embed",
        name: "Cohere Embeddings",
        provider_type: "cohere",
        base_url: "https://api.cohere.com",
        default_model: "embed-v4.0",
        available_models: ["embed-v4.0"],
        embedding_dimensions: 1536,
        embedding_dimension_options: [1536, 1024, 512, 256],
        api_key_required: true,
        task: "retrieval_embedding",
      }).provider_type,
    ).toBe("cohere");
    expect(ProviderPresetDTOSchema.safeParse({
      id: "bad",
      mode: "embedding",
      label: "Bad",
      name: "Bad",
      provider_type: "unknown",
      base_url: "https://example.test",
      available_models: [],
      api_key_required: false,
    }).success).toBe(false);
    expect(
      ProviderFromPresetCreateRequestSchema.parse({
        preset_id: "cohere_embedding",
        api_key: "request-only",
        embedding_dimensions: 1024,
      }).embedding_dimensions,
    ).toBe(1024);
  });

  it("documents provider and credential-channel value sets without constraining provider_type", () => {
    expect(ModelProviderDTOSchema.safeParse({
      id: "mp1",
      space_id: "s1",
      name: "Future",
      provider_type: "future_provider",
      base_url: "https://api.future.test/v1",
      claude_compatible_base_url: null,
      openai_compatible_base_url: null,
      default_model: null,
      available_models: [],
      enabled: true,
      is_default: false,
      has_api_key: false,
      created_at: "2026-06-11T12:00:00+00:00",
      updated_at: "2026-06-11T12:00:00+00:00",
    }).success).toBe(true);
    expect(isProviderType("anthropic")).toBe(true);
    expect(isProviderType("cohere")).toBe(true);
    expect(isProviderType("future_provider")).toBe(false);
    expect(isCredentialChannel("model_provider_api_key")).toBe(true);
    expect(isCredentialChannel("other")).toBe(false);
  });

  it("keeps credential channel metadata explicit and non-secret", () => {
    expect(
      CredentialChannelMetadataSchema.parse({
        channel: "model_provider_api_key",
        pooled: true,
        rotated: true,
      }),
    ).toEqual({
      channel: "model_provider_api_key",
      pooled: true,
      rotated: true,
    });
    expect(
      CredentialChannelMetadataSchema.safeParse({
        channel: "cli_login_state",
        pooled: true,
        rotated: false,
      }).success,
    ).toBe(false);
    expect(
      CredentialChannelMetadataSchema.safeParse({
        channel: "cli_login_state",
        pooled: false,
        rotated: false,
      }).success,
    ).toBe(true);
  });
});

describe("provider type-level contracts", () => {
  it("infers provider DTO types from schemas", () => {
    expectTypeOf<ModelProviderDTO>().toHaveProperty("space_id");
    expectTypeOf<ModelProviderDTO["has_api_key"]>().toEqualTypeOf<boolean>();
  });
});
