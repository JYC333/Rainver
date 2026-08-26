import type {
  ProviderFromPresetCreateRequest,
} from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../db.js";
import { isSpaceOwnerOrAdmin } from "../../access/roles.js";
import { updateSpaceRetrievalSettings } from "../../retrieval/settings.js";
import {
  enqueueRetrievalEmbeddingBackfill,
  resetRetrievalEmbeddingsForSpace,
} from "../../retrieval/embedding/job.js";
import { providerPresetById, type ProviderPreset } from "../presets/index.js";
import {
  ProviderCommandForbiddenError,
  ProviderCommandNotFoundError,
  ProviderCommandValidationError,
  type ModelProviderCreateInput,
  type ProviderCommandStore,
} from "./store.js";

function trimmed(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerIdFromCreated(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  throw new Error("created provider response did not include an id");
}

function selectedModel(preset: ProviderPreset, input: ProviderFromPresetCreateRequest): string | null {
  return trimmed(input.default_model)
    ?? preset.default_model
    ?? preset.available_models[0]
    ?? null;
}

function availableModels(preset: ProviderPreset, input: ProviderFromPresetCreateRequest): string[] {
  const overrides = input.available_models
    ?.map((model: string) => model.trim())
    .filter(Boolean);
  return overrides?.length ? overrides : preset.available_models;
}

function embeddingDimensions(
  preset: ProviderPreset,
  input: ProviderFromPresetCreateRequest,
): number {
  const dimensions = input.embedding_dimensions ?? preset.embedding_dimensions;
  if (!dimensions) {
    throw new ProviderCommandValidationError(
      `Provider preset '${preset.id}' does not define embedding dimensions`,
    );
  }
  const options = preset.embedding_dimension_options ?? [];
  if (options.length > 0 && !options.includes(dimensions)) {
    throw new ProviderCommandValidationError(
      `embedding_dimensions must be one of: ${options.join(", ")}`,
    );
  }
  return dimensions;
}

async function assertCanConfigureRetrievalPreset(
  config: ServerConfig,
  spaceId: string,
  userId: string,
): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error("Provider preset creation requires SERVER_DATABASE_URL");
  }
  const result = await getDbPool(config.databaseUrl).query<{ role: string }>(
    `SELECT role
       FROM space_memberships
      WHERE user_id = $1 AND space_id = $2 AND status = 'active'
      LIMIT 1`,
    [userId, spaceId],
  );
  if (!isSpaceOwnerOrAdmin(result.rows[0]?.role ?? null)) {
    throw new ProviderCommandForbiddenError("Requires space owner or admin role");
  }
}

function providerDb(config: ServerConfig) {
  if (!config.databaseUrl) {
    throw new Error("Provider preset creation requires SERVER_DATABASE_URL");
  }
  return getDbPool(config.databaseUrl);
}

function createInputForPreset(
  preset: ProviderPreset,
  input: ProviderFromPresetCreateRequest,
): ModelProviderCreateInput {
  return {
    name: input.name?.trim() || preset.name,
    provider_type: preset.provider_type,
    base_url: preset.base_url,
    network_profile_id: input.network_profile_id ?? null,
    claude_compatible_base_url: preset.claude_compatible_base_url ?? null,
    openai_compatible_base_url: preset.openai_compatible_base_url ?? null,
    api_key: input.api_key ?? null,
    default_model: selectedModel(preset, input),
    available_models: availableModels(preset, input),
    is_default: input.is_default,
  };
}

export async function createProviderFromPreset(
  config: ServerConfig,
  store: ProviderCommandStore,
  spaceId: string,
  userId: string,
  input: ProviderFromPresetCreateRequest,
): Promise<{ provider: unknown }> {
  const preset = providerPresetById(input.preset_id);
  if (!preset) {
    throw new ProviderCommandNotFoundError(`Provider preset '${input.preset_id}' not found`);
  }

  if (preset.mode === "embedding" || preset.mode === "rerank") {
    await assertCanConfigureRetrievalPreset(config, spaceId, userId);
  }

  const provider = await store.createProvider(
    spaceId,
    userId,
    createInputForPreset(preset, input),
  );
  const providerId = providerIdFromCreated(provider);
  try {
    if (preset.mode === "embedding") {
      await updateSpaceRetrievalSettings(
        providerDb(config),
        spaceId,
        { embedding_dimensions: embeddingDimensions(preset, input) },
        { actorUserId: userId },
      );
      await store.putTaskPolicy(
        spaceId,
        userId,
        "retrieval_embedding",
        [{ provider_id: providerId, model: selectedModel(preset, input) }],
        true,
      );
      await resetRetrievalEmbeddingsForSpace(config, spaceId);
      await enqueueRetrievalEmbeddingBackfill(config, {
        spaceId,
        userId,
        trigger: "retrieval_embedding_preset_create",
      });
    } else if (preset.mode === "rerank") {
      await updateSpaceRetrievalSettings(
        providerDb(config),
        spaceId,
        { rerank_enabled: true },
        { actorUserId: userId },
      );
      await store.putTaskPolicy(
        spaceId,
        userId,
        "retrieval_rerank",
        [{ provider_id: providerId, model: selectedModel(preset, input) }],
        true,
      );
    }
  } catch (error) {
    await store.deleteProvider(spaceId, userId, providerId).catch(() => undefined);
    throw error;
  }
  return { provider };
}
