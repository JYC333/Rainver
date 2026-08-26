import type { mapProviderRowToDto } from "../dbReader.js";
import { listProviderVendors, providerVendor } from "../vendors.js";
import {
  ProviderCommandValidationError,
  type ModelProviderCreateInput,
  type ProviderInfo,
  type RotationStrategy,
} from "./types.js";

/**
 * Vendor identity, credentialing, and published endpoints all come from the
 * registry. These used to be three hand-maintained lists here, next to a fourth
 * in the web client and a fifth in the provider-task table — which is how the
 * copies drifted.
 */
export const PROVIDER_TYPES = new Set(listProviderVendors().map((vendor) => vendor.id));
export const CLOUD_PROVIDER_TYPES = new Set(
  listProviderVendors().filter((vendor) => vendor.apiKeyRequired).map((vendor) => vendor.id),
);
export const ROTATION_STRATEGIES = new Set(["fill_first", "round_robin", "least_used", "random"]);

export type ProviderRow = Parameters<typeof mapProviderRowToDto>[0];

export interface PoolMemberRow {
  id: string;
  credential_id: string;
  name: string;
  position: number;
  enabled: boolean;
  healthy: boolean;
  cooldown_until: Date | null;
  last_failure_class: string | null;
  request_count: string | number;
  failure_count: string | number;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
  secret_ref?: string;
}

export function validateProviderType(providerType: string): void {
  if (!PROVIDER_TYPES.has(providerType)) {
    throw new ProviderCommandValidationError(
      `Invalid provider_type '${providerType}'. Must be one of: ${[...PROVIDER_TYPES]
        .sort()
        .join(", ")}`,
    );
  }
}

export function validateCreateFields(input: ModelProviderCreateInput): void {
  validateProviderType(input.provider_type);
  if (input.provider_type === "openai_codex") {
    throw new ProviderCommandValidationError(
      "OpenAI Codex providers must be connected through managed subscription OAuth",
    );
  }
  normalizeBaseUrl(input.provider_type, input.base_url);
  if (
    CLOUD_PROVIDER_TYPES.has(input.provider_type) &&
    !(input.api_key && input.api_key.trim())
  ) {
    throw new ProviderCommandValidationError(
      `api_key is required for provider_type '${input.provider_type}'`,
    );
  }
}

export function validateBaseUrl(providerType: string, baseUrl: string | null): void {
  normalizeBaseUrl(providerType, baseUrl);
}

export function configuredModelsFromRow(row: ProviderRow): string[] {
  const caps = row.capabilities_json;
  if (Array.isArray(caps)) return caps.filter((m): m is string => typeof m === "string");
  if (caps !== null && typeof caps === "object") {
    const models = (caps as { models?: unknown }).models;
    if (Array.isArray(models)) return models.filter((m): m is string => typeof m === "string");
  }
  return [];
}

export function configRecord(row: ProviderRow): Record<string, unknown> {
  return row.config_json !== null && typeof row.config_json === "object"
    ? { ...(row.config_json as Record<string, unknown>) }
    : {};
}

export function isDefaultFromRow(row: ProviderRow): boolean {
  if ("grant_is_default" in row && typeof row.grant_is_default === "boolean") {
    return row.grant_is_default;
  }
  return Boolean(configRecord(row).is_default);
}

export function rotationStrategyFromRow(row: ProviderRow): RotationStrategy {
  const value = configRecord(row).rotation_strategy;
  return typeof value === "string" && ROTATION_STRATEGIES.has(value)
    ? (value as RotationStrategy)
    : "fill_first";
}

export function fallbackProviderIdsFromRow(row: ProviderRow): string[] {
  const value = configRecord(row).fallback_provider_ids;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

export function claudeCompatibleBaseUrlFromRow(row: ProviderRow): string | null {
  const value = configRecord(row).claude_compatible_base_url;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function openAiCompatibleBaseUrlFromRow(row: ProviderRow): string | null {
  const value = configRecord(row).openai_compatible_base_url;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Ollama and a custom OpenAI-compatible endpoint publish no single address — a
 * local server may be anywhere, and a gateway is whatever the operator points
 * it at. Their registry entry still offers a starting point for the form, but
 * the server will not silently apply one: an omitted base URL for those two is
 * a validation error rather than a guess.
 */
const BASE_URL_MUST_BE_EXPLICIT = new Set(["ollama", "openai_compatible"]);

export function defaultBaseUrlFor(providerType: string): string | null {
  if (BASE_URL_MUST_BE_EXPLICIT.has(providerType)) return null;
  return providerVendor(providerType)?.defaultBaseUrl ?? null;
}

export function normalizeBaseUrl(providerType: string, baseUrl: string | null | undefined): string {
  const trimmed = optionalTrimmedString(baseUrl);
  if (trimmed) return trimmed;
  const fallback = defaultBaseUrlFor(providerType);
  if (fallback) return fallback;
  throw new ProviderCommandValidationError(
    `base_url is required for provider_type '${providerType}'`,
  );
}

export function providerInfoFromRow(row: ProviderRow): ProviderInfo {
  const providerType = row.provider_type;
  return {
    id: row.id,
    space_id: row.space_id,
    owner_user_id: row.owner_user_id ?? null,
    name: row.name,
    provider_type: providerType,
    base_url: normalizeBaseUrl(providerType, row.base_url),
    network_profile_id: row.network_profile_id ?? null,
    claude_compatible_base_url: claudeCompatibleBaseUrlFromRow(row),
    openai_compatible_base_url: openAiCompatibleBaseUrlFromRow(row),
    default_model: row.default_model,
    available_models: configuredModelsFromRow(row),
    enabled: Boolean(row.enabled),
    is_default: isDefaultFromRow(row),
  };
}

export function modelList(defaultModel: string | null | undefined, availableModels?: string[]): string[] {
  const models = [...(availableModels ?? [])];
  if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
  return models;
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function optionalTrimmedString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function mapPoolMember(row: PoolMemberRow): Record<string, unknown> {
  return {
    id: row.id,
    credential_id: row.credential_id,
    name: row.name,
    position: row.position,
    enabled: row.enabled,
    healthy: row.healthy,
    cooldown_until: row.cooldown_until ? row.cooldown_until.toISOString() : null,
    last_failure_class: row.last_failure_class,
    request_count: Number(row.request_count),
    failure_count: Number(row.failure_count),
    last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function orderPoolMembers<T extends {
  position: number;
  request_count: string | number;
  last_used_at: Date | null;
}>(members: T[], strategy: RotationStrategy): T[] {
  const sorted = [...members];
  switch (strategy) {
    case "round_robin":
      sorted.sort((a, b) => {
        const aT = a.last_used_at?.getTime() ?? 0;
        const bT = b.last_used_at?.getTime() ?? 0;
        return aT - bT || a.position - b.position;
      });
      return sorted;
    case "least_used":
      sorted.sort((a, b) => Number(a.request_count) - Number(b.request_count) || a.position - b.position);
      return sorted;
    case "random":
      for (let i = sorted.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      }
      return sorted;
    case "fill_first":
    default:
      sorted.sort((a, b) => a.position - b.position);
      return sorted;
  }
}
