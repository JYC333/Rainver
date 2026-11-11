import type { ServerConfig } from "../../config.js";
import { resolveProviderCommandStore } from "./commands/store.js";
import { ProviderCommandNotFoundError } from "./commands/types.js";
import { resolveProvidersDbPort } from "./dbReader.js";
import {
  completeProviderChat,
  completeProviderEmbedding,
  completeProviderRerank,
} from "./invocation/invocation.js";
import { requireProviderVendor } from "./vendors.js";

/**
 * A Provider connection test (`provider.test`): one small chat, or an
 * embedding/rerank probe for a retrieval-only vendor, spent as the person who
 * asked. It runs in the system command worker, outside every transaction.
 * Like the synchronous route it replaced, a vendor failure is a test result
 * (`success:false`), not a command failure; an unknown Provider is.
 */
function defaultRerankModelForProvider(providerType: string): string | null {
  if (providerType === "zeroentropy") return "zerank-2";
  if (providerType === "cohere") return "rerank-v4.0-pro";
  return null;
}

function configuredProviderModels(provider: { default_model?: string | null; available_models?: string[] }): string[] {
  return [provider.default_model, ...(provider.available_models ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function looksLikeEmbeddingModel(model: string): boolean {
  const value = model.toLowerCase();
  return value.startsWith("embed") || value.startsWith("zembed") || value.includes("embedding");
}

function looksLikeRerankModel(model: string): boolean {
  const value = model.toLowerCase();
  return value.startsWith("rerank") || value.startsWith("zerank") || value.includes("rerank");
}

function retrievalProviderTestScope(provider: { provider_type: string; default_model?: string | null; available_models?: string[] }): "embedding" | "rerank" | "both" {
  const models = configuredProviderModels(provider);
  const hasEmbedding = models.some(looksLikeEmbeddingModel);
  const hasRerank = models.some(looksLikeRerankModel);
  if (hasEmbedding && !hasRerank) return "embedding";
  if (hasRerank && !hasEmbedding) return "rerank";
  if (hasEmbedding && hasRerank) return "both";
  const vendor = requireProviderVendor(provider.provider_type);
  if (vendor.supportsEmbedding && vendor.supportsRerank) return "both";
  return vendor.supportsRerank ? "rerank" : "embedding";
}

function firstModelMatching(
  provider: { default_model?: string | null; available_models?: string[] },
  predicate: (model: string) => boolean,
): string | null {
  return configuredProviderModels(provider).find(predicate) ?? null;
}

/** The provider a connection test targets, read without resolving its key. */
export async function testedProvider(
  config: ServerConfig,
  identity: { spaceId: string; userId: string },
  providerId: string,
): Promise<{ id: string; provider_type: string; default_model: string | null; available_models: string[] }> {
  const provider = await resolveProvidersDbPort(config)?.getProvider(identity.spaceId, identity.userId, providerId);
  if (!provider || typeof provider !== "object") {
    throw new ProviderCommandNotFoundError(`ModelProvider '${providerId}' not found`);
  }
  const row = provider as Record<string, unknown>;
  return {
    id: String(row.id),
    provider_type: String(row.provider_type),
    default_model: typeof row.default_model === "string" ? row.default_model : null,
    available_models: Array.isArray(row.available_models)
      ? row.available_models.filter((model): model is string => typeof model === "string")
      : [],
  };
}


export async function runProviderConnectionTest(
  config: ServerConfig,
  identity: { spaceId: string; userId: string },
  providerId: string,
): Promise<{ success: boolean; message: string; model?: string | null }> {
  // Read without resolving a key: each completion below decides its spend before it resolves one.
  const provider = await testedProvider(config, identity, providerId);
  const store = resolveProviderCommandStore(config);
  try {
    const vendor = requireProviderVendor(provider.provider_type);
    if (!vendor.supportsChat && (vendor.supportsEmbedding || vendor.supportsRerank)) {
      const scope = retrievalProviderTestScope(provider);
      const embedding = scope === "rerank" ? null : await completeProviderEmbedding(store, identity.spaceId, {
        provider_id: provider.id,
        model: firstModelMatching(provider, looksLikeEmbeddingModel),
        inputs: ["rainver retrieval provider connection test"],
        inputType: "document",
        metering: { subject_user_id: identity.userId },
        spend: { kind: "person", user_id: identity.userId },
      });
      const rerank = scope === "embedding" ? null : await completeProviderRerank(store, identity.spaceId, {
        provider_id: provider.id,
        query: "retrieval provider test",
        documents: ["retrieval provider test document", "unrelated document"],
        topN: 1,
        model: firstModelMatching(provider, looksLikeRerankModel) ?? defaultRerankModelForProvider(provider.provider_type),
        metering: { subject_user_id: identity.userId },
        spend: { kind: "person", user_id: identity.userId },
      });
      const success = (embedding ? embedding.vectors.length > 0 : true) && (rerank ? rerank.scores.length > 0 : true);
      const message = scope === "embedding"
        ? "Embedding connection successful"
        : scope === "rerank"
          ? "Rerank connection successful"
          : "Embedding and rerank connection successful";
      return { success, message, model: [embedding?.model, rerank?.model].filter(Boolean).join("; ") };
    }
    const models = await store.listConfiguredModels(identity.spaceId, provider.id);
    const model = provider.default_model || models[0];
    if (!model) return { success: false, message: "No models configured" };
    const result = await completeProviderChat(store, identity.spaceId, {
      provider_id: provider.id,
      model,
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 5,
      metering: { subject_user_id: identity.userId },
      spend: { kind: "person", user_id: identity.userId },
    });
    return { success: true, message: "Connection successful", model: result.model };
  } catch (error) {
    return { success: false, message: (error instanceof Error ? error.message : "Connection failed").slice(0, 1000) };
  }
}
