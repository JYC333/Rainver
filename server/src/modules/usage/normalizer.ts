import { createHash, randomUUID } from "node:crypto";
import type {
  NormalizedUsageObservation,
  TotalTokensSource,
  UsageAccuracy,
  UsageBucketName,
  UsageDedupeConfidence,
  UsageDetails,
  UsageAttribution,
  UsageObservation,
} from "./types";

export const USAGE_NORMALIZATION_VERSION = 1;

const TRACE_UNSAFE_KEY_RE =
  /(api[_-]?key|authorization|bearer|token|secret|password|credential|prompt|completion|message|messages|content|stdout|stderr|transcript|body|request|response|system|user|assistant|file[_-]?content|raw|context|rendered)/i;

const DIMENSION_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_PROVIDER_USAGE_KEYS = new Set([
  "usage",
  "input",
  "output",
  "total",
  "total_tokens",
  "total_tokens_used",
  "prompt_tokens",
  "completion_tokens",
  "input_tokens",
  "output_tokens",
  "prompt_tokens_details",
  "completion_tokens_details",
  "input_token_details",
  "output_token_details",
  "cached_tokens",
  "audio_tokens",
  "image_tokens",
  "reasoning_tokens",
  "cache_creation_input_tokens",
  "cache_creation_1h_input_tokens",
  "cache_read_input_tokens",
  "billed_units",
  "search_units",
  "request_count",
  "requests",
  "classifications",
  "meta",
]);

export function normalizeUsageObservation(
  input: UsageObservation,
  instanceId: string,
  attribution: UsageAttribution,
  now = new Date(),
): NormalizedUsageObservation {
  const occurredAt = dateIso(input.occurred_at ?? now);
  const recordedAt = now.toISOString();
  const providerUsage = sanitizeProviderUsage(input.provider_usage);
  const explicit = usageDetailsFromUnknown(input.usage_details);
  const normalized = normalizeUsageDetails(explicit, providerUsage, input.event_type);
  const usageAccuracy = normalizeUsageAccuracy(
    input.usage_accuracy ?? inferAccuracy(providerUsage, explicit),
  );
  const totalTokensSource = normalized.totalTokensSource;
  const totalTokens = normalized.totalTokens;
  const id = randomUUID();
  const subject = inferSubject(input);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotency_key) ??
    fallbackIdempotencyKey(input, occurredAt, normalized.usageDetails);

  return {
    id,
    instance_id: instanceId,
    reporting_instance_id: input.reporting_instance_id ?? instanceId,
    origin_instance_id: input.origin_instance_id ?? instanceId,
    space_id: input.space_id,
    owner_user_id: attribution.owner_user_id,
    visibility: attribution.visibility,
    access_level: attribution.access_level,
    origin_space_id: trimOrNull(input.origin_space_id),
    event_type: input.event_type,
    source_type: input.source_type,
    source_resource_type: attribution.source_resource_type,
    source_resource_id: attribution.source_resource_id,
    execution_channel: input.execution_channel,
    meter_subject_type: subject.type,
    meter_subject_id: subject.id,
    subject_user_id: trimOrNull(input.subject_user_id),
    subject_team_id: trimOrNull(input.subject_team_id),
    adapter_type: trimOrNull(input.adapter_type),
    runtime_tool_version: trimOrNull(input.runtime_tool_version),
    provider_id: trimOrNull(input.provider_id),
    provider_type: trimOrNull(input.provider_type),
    provider_name_snapshot: trimOrNull(input.provider_name_snapshot),
    vendor: trimOrNull(input.vendor) ?? vendorFromProviderType(input.provider_type),
    model: trimOrNull(input.model),
    task: trimOrNull(input.task),
    run_id: trimOrNull(input.run_id),
    root_run_id: trimOrNull(input.root_run_id),
    parent_run_id: trimOrNull(input.parent_run_id),
    run_group_id: trimOrNull(input.run_group_id),
    session_id: trimOrNull(input.session_id),
    external_session_id: trimOrNull(input.external_session_id),
    session_path: safeSessionPath(input.session_path),
    session_name: trimOrNull(input.session_name),
    agent_id: trimOrNull(input.agent_id),
    project_id: attribution.project_id,
    project_folder_id: attribution.project_folder_id,
    trigger_origin: trimOrNull(input.trigger_origin),
    occurred_at: occurredAt,
    recorded_at: recordedAt,
    input_tokens: normalized.usageDetails.input ?? 0,
    output_tokens: normalized.usageDetails.output ?? 0,
    total_tokens: totalTokens,
    cache_creation_input_tokens: normalized.usageDetails.input_cache_creation ?? 0,
    cache_creation_1h_input_tokens: normalized.usageDetails.input_cache_creation_1h ?? 0,
    cache_read_input_tokens: normalized.usageDetails.input_cache_read ?? 0,
    reasoning_tokens: normalized.usageDetails.output_reasoning ?? 0,
    request_count: nonNegativeInt(input.request_count) ?? 1,
    estimated_cost_usd: finiteNumber(input.estimated_cost_usd),
    usage_schema: trimOrNull(input.usage_schema) ?? "agent_space_v1",
    usage_details_json: normalized.usageDetails,
    cost_details_json: safeTraceObject(input.cost_details),
    provider_usage_json: providerUsage,
    usage_normalization_version: USAGE_NORMALIZATION_VERSION,
    total_tokens_source: totalTokensSource,
    dimensions_json: sanitizeDimensions(input.dimensions),
    usage_accuracy: usageAccuracy,
    dedupe_confidence: normalizeDedupeConfidence(input.dedupe_confidence),
    import_batch_id: trimOrNull(input.import_batch_id),
    idempotency_key: idempotencyKey,
    metadata_json: safeTraceObject(input.metadata),
    grant_snapshots: attribution.grant_snapshots,
    created_at: recordedAt,
  };
}

/**
 * The single provider-usage extraction. Exported because the Runtime Host
 * envelope needs the same buckets the ledger records — a second extraction
 * would drift, and the two would then disagree about the same generation.
 */
export function normalizeUsageDetails(
  explicit: UsageDetails,
  providerUsage: Record<string, unknown>,
  eventType: UsageObservation["event_type"],
): {
  usageDetails: UsageDetails;
  totalTokens: number | null;
  totalTokensSource: TotalTokensSource;
} {
  const details: UsageDetails = {};
  addKnownBuckets(details, explicit);

  if (Object.keys(details).length === 0) {
    addKnownBuckets(details, providerUsage);
    addOpenAiDetails(details, providerUsage);
    addAnthropicDetails(details, providerUsage);
    addNestedUsageDetails(details, providerUsage);
  }

  if (eventType === "llm.embedding") {
    const embeddingInput = details.embedding_input ??
      intFrom(providerUsage.prompt_tokens) ??
      intFrom(providerUsage.input_tokens) ??
      details.input ??
      intFrom(providerUsage.total_tokens);
    if (embeddingInput !== undefined) {
      delete details.input;
      details.embedding_input = embeddingInput;
    }
  }

  const providerTotal =
    intFrom(providerUsage.total_tokens) ??
    intFrom(providerUsage.total_tokens_used) ??
    intFrom(providerUsage.total);
  const explicitTotal = details.total;
  if (providerTotal !== undefined) details.total = providerTotal;
  else if (explicitTotal !== undefined) details.total = explicitTotal;

  const bucketTotal = sumUsageBuckets(details);
  if (details.total !== undefined) {
    return {
      usageDetails: normalizeDetails(details),
      totalTokens: details.total,
      totalTokensSource: providerTotal !== undefined ? "provider_total" : "estimated",
    };
  }
  if (bucketTotal > 0) {
    return {
      usageDetails: normalizeDetails({ ...details, total: bucketTotal }),
      totalTokens: bucketTotal,
      totalTokensSource: "sum_of_buckets",
    };
  }
  return {
    usageDetails: normalizeDetails(details),
    totalTokens: null,
    totalTokensSource: "unknown",
  };
}

function addKnownBuckets(target: UsageDetails, source: Record<string, unknown>): void {
  const mappings: Array<[UsageBucketName, string[]]> = [
    ["input", ["input", "input_tokens"]],
    ["output", ["output", "output_tokens"]],
    ["input_cache_creation", ["input_cache_creation", "cache_creation_input_tokens"]],
    ["input_cache_creation_1h", ["input_cache_creation_1h", "cache_creation_1h_input_tokens"]],
    ["input_cache_read", ["input_cache_read", "cache_read_input_tokens", "cached_input_tokens"]],
    ["output_reasoning", ["output_reasoning", "reasoning_tokens", "output_reasoning_tokens"]],
    ["input_audio", ["input_audio"]],
    ["output_audio", ["output_audio"]],
    ["input_image", ["input_image"]],
    ["output_image", ["output_image"]],
    ["embedding_input", ["embedding_input", "embedding_input_tokens"]],
  ];
  for (const [bucket, keys] of mappings) {
    for (const key of keys) {
      const value = intFrom(source[key]);
      if (value !== undefined) {
        target[bucket] = value;
        break;
      }
    }
  }
  const total = intFrom(source.total);
  if (total !== undefined) target.total = total;
}

function addOpenAiDetails(target: UsageDetails, usage: Record<string, unknown>): void {
  const prompt = intFrom(usage.prompt_tokens);
  const completion = intFrom(usage.completion_tokens);
  const promptDetails = objectValue(usage.prompt_tokens_details);
  const completionDetails = objectValue(usage.completion_tokens_details);
  const cached = intFrom(promptDetails?.cached_tokens) ?? 0;
  const audioInput = intFrom(promptDetails?.audio_tokens) ?? 0;
  const reasoning = intFrom(completionDetails?.reasoning_tokens) ?? 0;
  const audioOutput = intFrom(completionDetails?.audio_tokens) ?? 0;

  if (prompt !== undefined) {
    target.input_cache_read = cached;
    if (audioInput > 0) target.input_audio = audioInput;
    target.input = Math.max(0, prompt - cached - audioInput);
  }
  if (completion !== undefined) {
    if (reasoning > 0) target.output_reasoning = reasoning;
    if (audioOutput > 0) target.output_audio = audioOutput;
    target.output = Math.max(0, completion - reasoning - audioOutput);
  }
}

function addAnthropicDetails(target: UsageDetails, usage: Record<string, unknown>): void {
  const cacheCreation = intFrom(usage.cache_creation_input_tokens);
  const cacheCreation1h = intFrom(usage.cache_creation_1h_input_tokens);
  const cacheRead = intFrom(usage.cache_read_input_tokens);
  const input = intFrom(usage.input_tokens);
  const output = intFrom(usage.output_tokens);
  if (cacheCreation !== undefined) target.input_cache_creation = cacheCreation;
  if (cacheCreation1h !== undefined) target.input_cache_creation_1h = cacheCreation1h;
  if (cacheRead !== undefined) target.input_cache_read = cacheRead;
  if (input !== undefined) target.input = input;
  if (output !== undefined) target.output = output;
}

function addNestedUsageDetails(target: UsageDetails, usage: Record<string, unknown>): void {
  const billedUnits = objectValue(usage.billed_units);
  if (billedUnits) {
    const input = intFrom(billedUnits.input_tokens) ?? intFrom(billedUnits.search_units);
    const output = intFrom(billedUnits.output_tokens);
    if (input !== undefined && target.input === undefined) target.input = input;
    if (output !== undefined && target.output === undefined) target.output = output;
  }
  const meta = objectValue(usage.meta);
  if (meta) addKnownBuckets(target, meta);
}

function normalizeDetails(details: UsageDetails): UsageDetails {
  const out: UsageDetails = {};
  for (const [key, value] of Object.entries(details)) {
    const normalized = nonNegativeInt(value);
    if (normalized !== undefined && normalized > 0) {
      out[key as UsageBucketName] = normalized;
    }
  }
  return out;
}

export function sumUsageBuckets(details: UsageDetails): number {
  let total = 0;
  for (const [key, value] of Object.entries(details)) {
    // The 1h bucket is a priced subtype of cache creation, not an additional
    // token bucket. Keep it for pricing/audit without double-counting totals.
    if (key === "total" || key === "input_cache_creation_1h") continue;
    total += nonNegativeInt(value) ?? 0;
  }
  return total;
}

function usageDetailsFromUnknown(value: unknown): UsageDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: UsageDetails = {};
  addKnownBuckets(out, value as Record<string, unknown>);
  return out;
}

function inferAccuracy(
  providerUsage: Record<string, unknown>,
  explicit: UsageDetails,
): UsageAccuracy {
  if (Object.keys(providerUsage).length > 0 || Object.keys(explicit).length > 0) {
    return "provider_reported";
  }
  return "unknown";
}

function inferSubject(input: UsageObservation): { type: string; id: string } {
  if (input.meter_subject_type && input.meter_subject_id) {
    return { type: input.meter_subject_type, id: input.meter_subject_id };
  }
  if (input.run_id) return { type: "run", id: input.run_id };
  if (input.agent_id) return { type: "agent", id: input.agent_id };
  if (input.session_id) return { type: "session", id: input.session_id };
  if (input.external_session_id) return { type: "session", id: input.external_session_id };
  if (input.subject_user_id) return { type: "user", id: input.subject_user_id };
  return { type: "space", id: input.space_id };
}

function fallbackIdempotencyKey(
  input: UsageObservation,
  occurredAt: string,
  details: UsageDetails,
): string {
  const stable = JSON.stringify({
    source_type: input.source_type,
    execution_channel: input.execution_channel,
    event_type: input.event_type,
    space_id: input.space_id,
    run_id: input.run_id ?? null,
    session_id: input.session_id ?? null,
    external_session_id: input.external_session_id ?? null,
    provider_id: input.provider_id ?? null,
    model: input.model ?? null,
    task: input.task ?? null,
    occurred_at: occurredAt,
    details,
    nonce: randomUUID(),
  });
  return `usage:${createHash("sha256").update(stable).digest("hex")}`;
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  const trimmed = trimOrNull(value);
  if (!trimmed) return null;
  return trimmed.slice(0, 256);
}

function sanitizeProviderUsage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return safeTraceObject(value as Record<string, unknown>, { allowUsageKeys: true });
}

export function safeTraceObject(
  value: unknown,
  options: { allowUsageKeys?: boolean } = {},
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (TRACE_UNSAFE_KEY_RE.test(key) && !(options.allowUsageKeys && isSafeProviderUsageKey(key))) {
      continue;
    }
    const safe = safeTraceValue(raw, 0, options);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

function safeTraceValue(
  value: unknown,
  depth: number,
  options: { allowUsageKeys?: boolean },
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 512)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return undefined;
    const arr = value.slice(0, 32).map((item) => safeTraceValue(item, depth + 1, options));
    return arr.filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    if (depth >= 2) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (TRACE_UNSAFE_KEY_RE.test(key) && !(options.allowUsageKeys && isSafeProviderUsageKey(key))) {
        continue;
      }
      const safe = safeTraceValue(raw, depth + 1, options);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }
  return undefined;
}

function sanitizeDimensions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!DIMENSION_KEY_RE.test(key)) continue;
    const safe = dimensionValue(raw);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

function dimensionValue(value: unknown): string | number | boolean | Array<string | number | boolean> | undefined {
  if (typeof value === "string") return value.slice(0, 128);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out = value
      .slice(0, 16)
      .map((item) => dimensionValue(item))
      .filter((item): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      );
    return out;
  }
  return undefined;
}

function safeSessionPath(value: string | null | undefined): string | null {
  const trimmed = trimOrNull(value);
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  return trimmed.slice(0, 1024);
}

function vendorFromProviderType(value: string | null | undefined): string | null {
  const providerType = trimOrNull(value);
  if (!providerType) return null;
  if (["openai", "anthropic", "minimax", "openrouter", "deepseek", "ollama", "zeroentropy", "cohere"].includes(providerType)) {
    return providerType;
  }
  return "other";
}

function dateIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function intFrom(value: unknown): number | undefined {
  const parsed = nonNegativeInt(value);
  return parsed === undefined ? undefined : parsed;
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    const parsed = Number(value);
    if (parsed >= 0) return Math.trunc(parsed);
  }
  return undefined;
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function accuracyMixZero(): Record<UsageAccuracy, number> {
  return {
    provider_reported: 0,
    proxy_observed: 0,
    transcript_lower_bound: 0,
    estimated: 0,
    quota_snapshot: 0,
    unknown: 0,
  };
}

export function normalizeDedupeConfidence(value: unknown): UsageDedupeConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : "high";
}

function normalizeUsageAccuracy(value: unknown): UsageAccuracy {
  return value === "provider_reported" ||
    value === "proxy_observed" ||
    value === "transcript_lower_bound" ||
    value === "estimated" ||
    value === "quota_snapshot" ||
    value === "unknown"
    ? value
    : "unknown";
}

function isSafeProviderUsageKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return SAFE_PROVIDER_USAGE_KEYS.has(normalized) || normalized.endsWith("_tokens");
}
