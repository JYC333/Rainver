/**
 * Resilient provider invocation for the provider API-key channel.
 *
 * Provider resilience layering:
 *
 *   1. Key pool   — each attempt draws the next candidate key from the
 *                   provider's credential pool (rotation strategy ordered,
 *                   cooling keys excluded). The error taxonomy decides what a
 *                   failure does to the key: 429 retries the same key once
 *                   then rotates; quota-exhaustion / 402 rotate with a 24 h
 *                   cooldown; 401/403 rotate with a 24 h cooldown and an
 *                   unhealthy mark (pool keys are plain API keys — the
 *                   refresh-token step of the taxonomy applies only to OAuth
 *                   credentials, which live in the separate CLI channel and
 *                   are never pooled).
 *   2. Provider   — when a provider's keys are exhausted (or it fails with a
 *      fallback      transient 5xx/408 after one retry), invocation falls
 *                   back to the provider's configured fallback chain.
 *                   Fallback is PER REQUEST: nothing sticky is stored, so the
 *                   next user turn always restarts on the primary provider.
 *   3. Task chain — auxiliary tasks (reflector, checkpoint extractor, …) may carry a
 *                   ProviderTaskPolicy chain that takes precedence over the
 *                   caller's provider, which then acts as the safety net.
 *
 * API keys are passed as request parameters/headers only. They are never
 * written to process env and never returned in responses.
 */

import type {
  CanonicalToolCall,
  CanonicalToolDefinition,
} from "@rainver/protocol";
import { createHash } from "node:crypto";
import type {
  InvocationTarget,
  PoolKeyCandidate,
  ProviderCommandStore,
  ProviderInfo,
} from "../commands/store.js";
import type { ProviderTaskAttemptRefs } from "../commands/types.js";
import type { UsageAttribution, UsageObservation } from "../../usage/index.js";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { classifyProviderFailure, type ProviderResilienceDecision } from "./resilience.js";
import { fetchWithNetworkProfile, type ResolvedNetworkProfile } from "../../networkProfiles/index.js";
import {
  retrievalEgressAllowed,
  retrievalProviderEgressDestination,
  type RetrievalEgressPolicy,
} from "../../retrieval/egress/egressPolicy.js";
import { normalizeGatewayShapes, normalizeNullableNearMisses, validateStructuredOutput } from "../../runs/structuredOutputValidation.js";
import { providerSupportsStructuredOutput } from "../structuredOutputCapabilities.js";
import { providerVendor } from "../vendors.js";
import { completePiAiChat } from "./piAiChat.js";

export interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: CanonicalToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ProviderChatRequestBody {
  provider_id?: string | null;
  model?: string | null;
  messages: ChatMessage[];
  system?: string | null;
  temperature?: number;
  max_tokens?: number;
  tools?: CanonicalToolDefinition[] | null;
  output_format?: ProviderStructuredOutput | null;
  cache_strategy?: "conversation";
  on_text_delta?: (delta: string) => void;
  abort_signal?: AbortSignal;
  egressPolicy?: RetrievalEgressPolicy | null;
  /** Managed Runtime Context deliveries authorize one physical provider only. */
  allow_provider_fallback?: boolean;
  metering: ProviderMeteringContext;
}

export interface ProviderChatResponseBody {
  content: string;
  provider: string;
  model: string;
  usage: Record<string, unknown>;
  cost?: ProviderUsageCost;
  cost_accuracy: "catalog" | "unknown";
  tool_calls?: CanonicalToolCall[];
  structured_output?: Record<string, unknown> | null;
  finish_reason?: string | null;
}

export interface ProviderUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type ProviderChatInvocationResult = ProviderChatResponseBody & {
  /** The configured ModelProvider row that actually served the request. */
  provider_id: string;
};

/**
 * Safe diagnostics for a structured-output failure.
 *
 * These describe the provider response shape plus a bounded normalized-text
 * preview for triage. They never retain prompt text, credentials, or request
 * headers. The full raw response, when available, is carried separately on
 * ProviderInvocationError for failure logging only.
 */
export type StructuredOutputDiagnostics = Record<string, unknown>;

export interface ProviderStructuredOutput {
  type: "json_schema";
  schema_id: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  stage?: string;
}

export type ProviderMeteringContext = Partial<UsageObservation>;

export class ProviderInvocationError extends Error {
  /** How many real network attempts (initial + same-key retries) were made
   * for the request that ultimately threw this error. Set by
   * invokeProviderWithPool after construction — callers that report a
   * fixed "attempt=1" in error text should use this instead. */
  attempts?: number;

  constructor(
    readonly statusCode: number,
    message: string,
    readonly resilience?: ProviderResilienceDecision,
    /** Stable code so callers can branch (e.g. degrade) without string-matching. */
    readonly code?: string,
    readonly diagnostics?: StructuredOutputDiagnostics,
    /** Provider text is retained only for the failure logger, not run evidence. */
    readonly responseText?: string,
  ) {
    super(message);
    this.name = "ProviderInvocationError";
  }
}

export interface ProviderHttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

let httpClientOverride: ProviderHttpClient | null = null;

export function __setProviderHttpClientForTests(client: ProviderHttpClient | null): void {
  httpClientOverride = client;
}

// undici's default connector already turns on TCP keepalive, but with a 60s
// initial delay before the first probe (see undici/lib/core/connect.js).
// Some providers sit behind a NAT/idle-connection timeout shorter than that
// (observed with MiniMax: connections held open past ~60s while the model is
// still generating get an ECONNRESET before the first probe ever goes out).
// A shorter initial delay lets the OS refresh the NAT mapping in time.
const PROVIDER_KEEPALIVE_INITIAL_DELAY_MS = 15_000;

let defaultDispatcher: UndiciAgent | null = null;

function defaultProviderDispatcher(): UndiciAgent {
  defaultDispatcher ??= new UndiciAgent({
    connect: { keepAlive: true, keepAliveInitialDelay: PROVIDER_KEEPALIVE_INITIAL_DELAY_MS },
  });
  return defaultDispatcher;
}

function defaultProviderFetch(url: string, init?: RequestInit): Promise<Response> {
  return undiciFetch(url, {
    ...(init ?? {}),
    dispatcher: defaultProviderDispatcher(),
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

function httpClient(profile?: ResolvedNetworkProfile | null): ProviderHttpClient {
  if (!httpClientOverride && profile) return { fetch: fetchWithNetworkProfile(profile) };
  return httpClientOverride ?? { fetch: defaultProviderFetch };
}

async function fetchProviderResponse(
  profile: ResolvedNetworkProfile | null | undefined,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    const headers = new Headers(init?.headers);
    // Provider responses are consumed by server-side fetch. Requesting an
    // identity representation avoids Brotli/gzip decompression failures from
    // provider or proxy content-encoding mismatches.
    headers.set("accept-encoding", "identity");
    return await httpClient(profile).fetch(url, {
      ...init,
      headers: Object.fromEntries(headers.entries()),
    });
  } catch (error) {
    if (error instanceof ProviderInvocationError) throw error;
    if (init?.signal?.aborted) {
      throw new ProviderInvocationError(
        499,
        "Provider request was cancelled by the run owner",
        { failure_class: "permanent", actions: ["fail"] },
        "provider_request_aborted",
      );
    }
    throw new ProviderInvocationError(
      502,
      `Provider network request failed (${safeUrlForError(url)}): ${errorDetail(error)}`,
      { failure_class: "transient", actions: ["fallback_provider", "fail"] },
      "provider_network_error",
    );
  }
}

function safeUrlForError(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return value.split("?")[0] ?? value;
  }
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "request failed before a provider response was received";
  const cause = error.cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
    return `${error.message}: ${cause.code}`;
  }
  return error.message || "request failed before a provider response was received";
}

function bareModelName(providerType: string, model: string): string {
  if (providerType === "anthropic" && model.startsWith("anthropic/")) {
    return model.slice("anthropic/".length);
  }
  if (providerType === "openrouter" && model.startsWith("openrouter/")) {
    return model.slice("openrouter/".length);
  }
  if (providerType === "ollama" && model.startsWith("ollama/")) {
    return model.slice("ollama/".length);
  }
  if (providerType === "zeroentropy" && model.startsWith("zeroentropy/")) {
    return model.slice("zeroentropy/".length);
  }
  if (providerType === "cohere" && model.startsWith("cohere/")) {
    return model.slice("cohere/".length);
  }
  if (["openai", "openai_compatible", "deepseek"].includes(providerType) && model.startsWith("openai/")) {
    return model.slice("openai/".length);
  }
  return model;
}

function defaultModelFor(providerType: string): string {
  if (providerType === "anthropic") return "claude-3-5-sonnet-latest";
  if (providerType === "openrouter") return "openai/gpt-4o-mini";
  if (providerType === "ollama") return "llama3";
  if (providerType === "zeroentropy") return "zembed-1";
  if (providerType === "cohere") return "embed-v4.0";
  return "gpt-4o-mini";
}

function resolveModel(provider: ProviderInfo, requested?: string | null): string {
  return (
    requested ||
    provider.default_model ||
    provider.available_models[0] ||
    defaultModelFor(provider.provider_type)
  );
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    const decision = classifyProviderFailure(response.status, text);
    throw new ProviderInvocationError(
      502,
      `Provider request failed with status ${response.status}`,
      decision,
      // Rate limits carry a stable code so the Run Supervisor can classify
      // the terminal attempt as retryable; quota exhaustion stays codeless
      // (a retry would fail identically until the key or plan changes).
      decision.failure_class === "rate_limit" ? "provider_rate_limit" : undefined,
    );
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderInvocationError(502, "Provider returned invalid JSON");
  }
}

function openAiBase(provider: ProviderInfo): string {
  if (provider.base_url) return provider.base_url.replace(/\/+$/, "");
  if (provider.provider_type === "openrouter") return "https://openrouter.ai/api/v1";
  return "https://api.openai.com/v1";
}


function cohereV2Base(provider: ProviderInfo): string {
  const base = (provider.base_url || "https://api.cohere.com").replace(/\/+$/, "");
  return base.endsWith("/v2") ? base : `${base}/v2`;
}

function providerSupportsRuntimeTools(providerType: string): boolean {
  return providerVendor(providerType)?.supportsRuntimeTools ?? false;
}

function diagnosticSummary(diagnostics: StructuredOutputDiagnostics | undefined): string {
  if (!diagnostics || Object.keys(diagnostics).length === 0) return "";
  return Object.entries(diagnostics)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`)
    .join("; ");
}

type StructuredOutputNormalization =
  | "none"
  | "reasoning_envelope"
  | "json_fence"
  | "embedded_json_fence"
  | "json_slice";

/**
 * Reasoning models wrap the contractual JSON in transport noise in several
 * combinable ways: a provider-specific `<think>...</think>` envelope, a
 * markdown code fence, and/or surrounding prose ("Here is the result: {...}
 * Let me know."). None of that noise is part of the structured-output
 * contract, so produce extraction candidates in decreasing strictness; the
 * caller takes the first one that parses as JSON. Schema validation remains
 * the real contract gate, so liberal extraction here cannot let a
 * non-conforming payload through.
 */
function structuredOutputCandidates(text: string): Array<{
  text: string;
  normalization: StructuredOutputNormalization;
}> {
  const trimmed = text.trim();
  const withoutReasoning = trimmed
    .replace(/^<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, "")
    .trim();
  const base = withoutReasoning;
  const baseNormalization: StructuredOutputNormalization = base === trimmed ? "none" : "reasoning_envelope";
  const candidates: Array<{ text: string; normalization: StructuredOutputNormalization }> = [
    { text: base, normalization: baseNormalization },
  ];
  const fenced = base.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    candidates.push({ text: fenced[1]!.trim(), normalization: "json_fence" });
  } else {
    const embedded = base.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (embedded) candidates.push({ text: embedded[1]!.trim(), normalization: "embedded_json_fence" });
  }
  for (const slice of balancedJsonSlices(base)) {
    if (candidates.every((candidate) => candidate.text !== slice)) {
      candidates.push({ text: slice, normalization: "json_slice" });
    }
  }
  return candidates;
}

function balancedJsonSlices(text: string): string[] {
  const slices: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    const opening = text[start];
    if (opening !== "{" && opening !== "[") continue;
    const end = balancedJsonEnd(text, start);
    if (end === null) continue;
    const slice = text.slice(start, end).trim();
    if (slice && !slices.includes(slice)) slices.push(slice);
  }
  return slices;
}

function balancedJsonEnd(text: string, start: number): number | null {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") return null;
  const stack: string[] = [opening];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const expectedOpening = character === "}" ? "{" : "[";
    if (stack.at(-1) !== expectedOpening) return null;
    stack.pop();
    if (stack.length === 0) return index + 1;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withResponseText(error: ProviderInvocationError, text: string): ProviderInvocationError {
  if (error.responseText !== undefined) return error;
  return new ProviderInvocationError(error.statusCode, error.message, error.resilience, error.code, error.diagnostics, text);
}

function structuredOutputFromValue(
  value: unknown,
  outputFormat: ProviderStructuredOutput,
  diagnostics?: StructuredOutputDiagnostics,
): Record<string, unknown> {
  if (isPlainObject(value)) {
    const schemaError = validateStructuredOutput(value, outputFormat);
    if (!schemaError) return value;
    const attempts: Record<string, unknown>[] = [];
    const push = (candidate: unknown) => { if (isPlainObject(candidate)) attempts.push(candidate); };
    const expand = (candidate: Record<string, unknown>) => {
      const unwrapped = unwrapTextNodes(candidate);
      if (unwrapped.changed) push(unwrapped.value);
      const base = unwrapped.changed && isPlainObject(unwrapped.value) ? unwrapped.value : candidate;
      const nullNormalized = normalizeNullableNearMisses(base, outputFormat.schema);
      if (nullNormalized.changed) push(nullNormalized.value);
      const gatewayBase = nullNormalized.changed && isPlainObject(nullNormalized.value) ? nullNormalized.value : base;
      const gatewayNormalized = normalizeGatewayShapes(gatewayBase, outputFormat.schema);
      if (gatewayNormalized.changed) push(gatewayNormalized.value);
    };
    expand(value);
    // Tool-call gateways sometimes nest the payload one level deep under the
    // tool/schema name (observed with MiniMax-M3 forced tool calls). Peel
    // single-key object wrappers, at most two levels, and revalidate.
    let wrapper: Record<string, unknown> = value;
    for (let depth = 0; depth < 2; depth += 1) {
      const keys = Object.keys(wrapper);
      if (keys.length !== 1) break;
      const inner = wrapper[keys[0]!];
      if (!isPlainObject(inner)) break;
      push(inner);
      expand(inner);
      wrapper = inner;
    }
    for (const attempt of attempts) {
      if (!validateStructuredOutput(attempt, outputFormat)) return attempt;
    }
    const details = {
      json_top_level_keys: Object.keys(value).slice(0, 12).join("|") || "none",
      ...(diagnostics ?? {}),
    };
    throw new ProviderInvocationError(
      502,
      `Provider returned structured output that failed schema '${outputFormat.schema_id}' at ${schemaError}${diagnosticSummary(details) ? ` (${diagnosticSummary(details)})` : ""}`,
      { failure_class: "permanent", actions: ["fail"] },
      "structured_output_invalid",
      details,
    );
  }
  const valueType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const details = { value_type: valueType, ...(diagnostics ?? {}) };
  throw new ProviderInvocationError(
    502,
    `Provider returned invalid structured output for schema '${outputFormat.schema_id}' (${diagnosticSummary(details)})`,
    { failure_class: "permanent", actions: ["fail"] },
    "structured_output_invalid",
    details,
  );
}

/**
 * XML-to-JSON tool-call gateways (observed with MiniMax's OpenAI-compatible
 * layer) represent a string the model emitted where the schema expects an
 * object as a single-key text node: {"$text": "<json-encoded payload>"}.
 * Recursively replace exact {"$text": string} nodes with the parsed payload
 * (or the raw string when it is not JSON) so schema validation sees the value
 * the model intended. Objects with any other keys are never touched.
 */
function unwrapTextNodes(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const result = unwrapTextNodes(item);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: changed ? items : value, changed };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "$text" && typeof record.$text === "string") {
      try {
        return { value: unwrapTextNodes(JSON.parse(record.$text)).value, changed: true };
      } catch {
        return { value: record.$text, changed: true };
      }
    }
    let changed = false;
    const entries = Object.entries(record).map(([key, item]) => {
      const result = unwrapTextNodes(item);
      changed = changed || result.changed;
      return [key, result.value] as const;
    });
    return { value: changed ? Object.fromEntries(entries) : value, changed };
  }
  return { value, changed: false };
}

export function structuredOutputFromText(
  text: unknown,
  outputFormat: ProviderStructuredOutput,
  diagnostics?: StructuredOutputDiagnostics,
): Record<string, unknown> {
  if (typeof text !== "string") {
    return structuredOutputFromValue(text, outputFormat, {
      response_kind: "non_text_content",
      content_type: text === null ? "null" : Array.isArray(text) ? "array" : typeof text,
      ...(diagnostics ?? {}),
    });
  }
  const candidates = structuredOutputCandidates(text);
  const diagnosticsFor = (candidate: { text: string; normalization: StructuredOutputNormalization }) => ({
    response_kind: candidate.text ? "text" : "empty_text",
    content_length: text.length,
    normalized_length: candidate.text.length,
    first_non_whitespace: text.trim()[0] ?? "none",
    last_non_whitespace: text.trim().at(-1) ?? "none",
    normalization: candidate.normalization,
    ...(diagnostics ?? {}),
  }) satisfies StructuredOutputDiagnostics;
  let firstSchemaError: ProviderInvocationError | null = null;
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate.text);
    } catch {
      continue;
    }
    try {
      return structuredOutputFromValue(value, outputFormat, {
        ...diagnosticsFor(candidate),
        parse_result: "valid_json",
        json_value_type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      });
    } catch (error) {
      if (error instanceof ProviderInvocationError && error.code === "structured_output_invalid") {
        firstSchemaError ??= withResponseText(error, text);
        continue;
      }
      throw error;
    }
  }
  if (firstSchemaError) throw firstSchemaError;
  throw invalidStructuredOutputError(outputFormat.schema_id, {
    ...diagnosticsFor(candidates[0]!),
    candidate_normalizations: candidates.map((candidate) => candidate.normalization).join(","),
    parse_result: "invalid_json",
  });
}

function invalidStructuredOutputError(
  schemaId: string,
  diagnostics?: StructuredOutputDiagnostics,
): ProviderInvocationError {
  return new ProviderInvocationError(
    502,
    `Provider returned invalid structured output for schema '${schemaId}'${diagnosticSummary(diagnostics) ? ` (${diagnosticSummary(diagnostics)})` : ""}`,
    { failure_class: "permanent", actions: ["fail"] },
    "structured_output_invalid",
    diagnostics,
  );
}

// ---------------------------------------------------------------------------
// Single-attempt provider calls (one key, one request)
// ---------------------------------------------------------------------------

function attemptOnce(
  target: InvocationTarget,
  apiKey: string | null,
  body: ProviderChatRequestBody,
): Promise<ProviderChatResponseBody> {
  const provider = target.provider;
  if (body.output_format && !providerSupportsStructuredOutput(provider.provider_type)) {
    throw structuredOutputUnsupportedError(provider.provider_type);
  }
  if (body.tools?.length && !providerSupportsRuntimeTools(provider.provider_type)) {
    throw new ProviderInvocationError(
      400,
      `provider_type '${provider.provider_type}' does not support runtime-host tools yet; use an OpenAI-compatible or Anthropic provider, or disable retrieval tools for this run`,
      { failure_class: "permanent", actions: ["fail"] },
      "runtime_tool_provider_unsupported",
    );
  }
  return completePiAiChat(
    provider,
    httpClient(target.network_profile).fetch as typeof globalThis.fetch,
    apiKey,
    body,
  );
}

function structuredOutputUnsupportedError(providerType: string): ProviderInvocationError {
  return new ProviderInvocationError(
    422,
    `Provider type '${providerType}' does not support structured output`,
    { failure_class: "permanent", actions: ["fail"] },
    "structured_output_unsupported",
  );
}

function providerTargetEgressAllowed(
  target: InvocationTarget,
  policy: RetrievalEgressPolicy | null | undefined,
): boolean {
  if (!policy) return true;
  return retrievalEgressAllowed(
    {
      object_type: "model_provider",
      object_id: target.provider.id,
      source_connection_ids: policy.payloadSourceConnectionIds,
    },
    {
      ...policy,
      destination: retrievalProviderEgressDestination(target.provider),
    },
  );
}

function providerEgressDeniedError(target: InvocationTarget): ProviderInvocationError {
  return new ProviderInvocationError(
    403,
    `retrieval egress policy blocks provider '${target.provider.id}' (${target.provider.provider_type})`,
    undefined,
    "retrieval_egress_denied",
  );
}

async function recordProviderUsage(
  store: ProviderCommandStore,
  target: InvocationTarget,
  input: {
    spaceId: string;
    eventType: UsageObservation["event_type"];
    model: string | null | undefined;
    usage: Record<string, unknown>;
    cost?: ProviderUsageCost;
    costAccuracy?: "catalog" | "unknown";
    metering?: ProviderMeteringContext | null;
    attribution: UsageAttribution;
  },
): Promise<void> {
  const context = input.metering ?? {};
  const provider = target.provider;
  const costAccuracy = input.costAccuracy ?? context.cost_accuracy ?? "unknown";
  const catalogCost = costAccuracy === "catalog"
    ? nonNegativeFiniteNumber(input.cost?.total)
    : null;
  const observation: UsageObservation = {
    ...context,
    space_id: input.spaceId,
    event_type: input.eventType,
    source_type: context.source_type ?? "local_run",
    execution_channel: context.execution_channel ?? "managed_api",
    provider_id: provider.id,
    provider_type: provider.provider_type,
    provider_name_snapshot: provider.name,
    vendor: context.vendor ?? provider.provider_type,
    model: input.model ?? context.model ?? provider.default_model,
    provider_usage: input.usage,
    estimated_cost_usd: input.costAccuracy !== undefined
      ? catalogCost
      : context.estimated_cost_usd ?? null,
    cost_accuracy: costAccuracy,
    cost_details: input.cost && catalogCost !== null
      ? {
          source: "pi_ai_catalog",
          input: input.cost.input,
          output: input.cost.output,
          cacheRead: input.cost.cacheRead,
          cacheWrite: input.cost.cacheWrite,
          total: input.cost.total,
        }
      : context.cost_details ?? null,
    usage_accuracy: context.usage_accuracy ?? (hasUsage(input.usage) ? "provider_reported" : "unknown"),
  };
  try {
    await store.recordUsageObservation(observation, input.attribution);
  } catch {
    throw new ProviderInvocationError(
      502,
      "Usage metering failed",
      undefined,
      "usage_metering_failed",
    );
  }
}

function nonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isUsageMeteringFailure(error: unknown): boolean {
  return error instanceof ProviderInvocationError && error.code === "usage_metering_failed";
}

function hasUsage(value: Record<string, unknown>): boolean {
  return Object.values(value).some(hasUsageValue);
}

function hasUsageValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasUsageValue);
  if (typeof value === "object") return Object.values(value).some(hasUsageValue);
  return false;
}

function meteringContext(
  context: ProviderMeteringContext,
  task: string | null | undefined,
): ProviderMeteringContext {
  return {
    ...context,
    task: context.task ?? task ?? null,
  };
}

async function beginProviderTaskAttempt(
  store: ProviderCommandStore,
  target: InvocationTarget,
  metering: ProviderMeteringContext,
  input: {
    eventType: UsageObservation["event_type"];
    model: string | null | undefined;
    input: unknown;
  },
): Promise<ProviderTaskAttemptRefs | null> {
  if (!store.beginProviderTaskAttempt) return null;
  const existingAudit = recordValue(metering.metadata).runtime_context_audit_refs;
  if (existingAudit && typeof existingAudit === "object") return null;
  const task = metering.task?.trim() || "provider_task";
  const ownerDomain = providerTaskOwnerDomain(task);
  return store.beginProviderTaskAttempt({
    space_id: target.provider.space_id,
    task,
    owner_domain: ownerDomain,
    provider_id: target.provider.id,
    model: input.model ?? null,
    input_fingerprint: createHash("sha256").update(JSON.stringify({
      event_type: input.eventType,
      task,
      provider_id: target.provider.id,
      model: input.model ?? null,
      input: input.input,
    })).digest("hex"),
    metering: {
      ...metering,
      space_id: target.provider.space_id,
      event_type: input.eventType,
      source_type: metering.source_type ?? "local_run",
      execution_channel: metering.execution_channel ?? "managed_api",
    },
  });
}

function meteringWithProviderTaskRefs(
  metering: ProviderMeteringContext,
  refs: ProviderTaskAttemptRefs | null,
): ProviderMeteringContext {
  if (!refs) {
    const runtimeRefs = recordValue(recordValue(metering.metadata).runtime_context_audit_refs);
    const usageSourceId = typeof runtimeRefs.usage_source_id === "string"
      ? runtimeRefs.usage_source_id
      : null;
    if (!usageSourceId) return metering;
    return { ...metering, idempotency_key: usageSourceId };
  }
  return {
    ...metering,
    idempotency_key: refs.usage_source_id,
    dimensions: {
      ...recordValue(metering.dimensions),
      provider_task_control_id: refs.control_id,
      delivery_id: refs.delivery_id,
      invocation_snapshot_id: refs.invocation_snapshot_id,
      usage_source_id: refs.usage_source_id,
    },
    metadata: {
      ...recordValue(metering.metadata),
      provider_task_audit_refs: refs,
    },
  };
}

function providerTaskOwnerDomain(task: string): string {
  if (task === "daily_report") return "dailyReports";
  if (task.startsWith("inquiry_")) return "inquiry";
  if (task.startsWith("project_research_")) return "projectResearch";
  if (task.startsWith("project_public_summary")) return "projects";
  if (task.startsWith("research_query_")) return "research";
  if (task.startsWith("retrieval_")) return "retrieval";
  if (task.startsWith("room_")) return "rooms";
  if (task === "context.checkpoint.extract") return "runtimeContext";
  return "providers";
}

async function recordFailedProviderAttemptUsage(
  store: ProviderCommandStore,
  target: InvocationTarget,
  input: {
    eventType: UsageObservation["event_type"];
    model: string | null | undefined;
    metering: ProviderMeteringContext;
    attribution: UsageAttribution;
    refs: ProviderTaskAttemptRefs | null;
    error: unknown;
  },
): Promise<void> {
  const errorCode = providerErrorCode(input.error);
  const metering = meteringWithProviderTaskRefs(input.metering, input.refs);
  await recordProviderUsage(store, target, {
    spaceId: target.provider.space_id,
    eventType: input.eventType,
    model: input.model,
    usage: {},
    metering: {
      ...metering,
      dimensions: {
        ...recordValue(metering.dimensions),
        provider_attempt_status: "failed",
        provider_attempt_error_code: errorCode,
      },
    },
    attribution: input.attribution,
  });
}

async function completeProviderTaskAttempt(
  store: ProviderCommandStore,
  refs: ProviderTaskAttemptRefs | null,
  status: "accepted" | "failed",
  errorCode: string | null,
): Promise<void> {
  if (!refs || !store.completeProviderTaskAttempt) return;
  await store.completeProviderTaskAttempt(refs, { status, error_code: errorCode });
}

function providerErrorCode(error: unknown): string {
  return error instanceof ProviderInvocationError
    ? error.code ?? `provider_http_${error.statusCode}`
    : "provider_invocation_failed";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertMeteringContext(context: ProviderMeteringContext): void {
  const sourceType = Boolean(context.source_resource_type?.trim());
  const sourceId = Boolean(context.source_resource_id?.trim());
  if (sourceType !== sourceId) {
    throw new ProviderInvocationError(
      422,
      "Model invocation metering source type and id must be provided together",
      undefined,
      "usage_attribution_required",
    );
  }
  const attributed = Boolean(
    context.subject_user_id?.trim() ||
    context.run_id?.trim() ||
    context.agent_id?.trim() ||
    (sourceType && sourceId) ||
    (context.space_system_task === true && context.meter_subject_type === "space_system"),
  );
  if (!attributed) {
    throw new ProviderInvocationError(
      422,
      "Model invocation requires usage owner or source attribution",
      undefined,
      "usage_attribution_required",
    );
  }
}

async function resolveProviderUsageAttribution(
  store: ProviderCommandStore,
  spaceId: string,
  eventType: UsageObservation["event_type"],
  context: ProviderMeteringContext,
): Promise<UsageAttribution> {
  try {
    return await store.resolveUsageAttribution({
      ...context,
      space_id: spaceId,
      event_type: eventType,
      source_type: context.source_type ?? "local_run",
      execution_channel: context.execution_channel ?? "managed_api",
    });
  } catch (error) {
    if (error instanceof ProviderInvocationError) throw error;
    const candidateStatus = (error as { statusCode?: unknown })?.statusCode;
    const statusCode = typeof candidateStatus === "number" && candidateStatus >= 400 && candidateStatus <= 599
      ? candidateStatus
      : 502;
    throw new ProviderInvocationError(
      statusCode,
      statusCode < 500 && error instanceof Error ? error.message : "Usage attribution failed",
      undefined,
      statusCode < 500 ? "usage_attribution_required" : "usage_attribution_failed",
    );
  }
}

function requiredAttribution(attribution: UsageAttribution | undefined): UsageAttribution {
  if (attribution) return attribution;
  throw new ProviderInvocationError(
    502,
    "Usage attribution was not prepared",
    undefined,
    "usage_attribution_failed",
  );
}

function mergeUsage(...items: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of items) {
    if (!item) continue;
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        out[key] = typeof out[key] === "number" ? (out[key] as number) + value : value;
      } else if (out[key] === undefined && value !== undefined) {
        out[key] = value;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resilience engine
// ---------------------------------------------------------------------------

const DAY_SECONDS = 24 * 60 * 60;

async function recordFailure(
  store: ProviderCommandStore,
  candidate: PoolKeyCandidate,
  decision: ProviderResilienceDecision,
): Promise<void> {
  if (!candidate.member_id) return;
  await store.recordPoolOutcome(candidate.member_id, {
    kind: "failure",
    failure_class: decision.failure_class,
    cooldown_seconds:
      decision.failure_class === "quota_exhausted" ||
      decision.failure_class === "payment_required" ||
      decision.failure_class === "unauthorized"
        ? decision.cooldown_seconds ?? DAY_SECONDS
        : undefined,
    unhealthy: decision.failure_class === "unauthorized",
  });
}

// A transient/rate-limit failure on a given key gets this many same-key
// retries before moving on (rotate to the next key, or hand off to the
// provider fallback layer for "transient"). Keep this at 1: callers rely on
// a single same-key retry before rotation/fallback kicks in (see
// providersResilience.test.ts), so raising it delays failover by an extra
// round-trip per key.
const MAX_SAME_KEY_RETRIES = 1;
// A pure network failure (no response ever received — DNS, ECONNRESET,
// timeout; see the "provider_network_error" throw in fetchProviderResponse)
// is unrelated to which key or account is used and often clears up within a
// couple of attempts, unlike a provider-classified transient *response*
// (e.g. 503) where hammering the same key is less likely to help. Give it a
// larger same-key budget before handing off to the fallback layer.
const MAX_NETWORK_ERROR_RETRIES = 3;
// Base delay before a network-error retry, doubling per attempt (500ms,
// 1s, 1.5s for the 3 retries). Retrying a connection reset instantly
// guarantees hitting the same narrow failure window again if it recurs
// (see PROVIDER_KEEPALIVE_INITIAL_DELAY_MS above) — a short, increasing gap
// gives whatever caused it (a brief network blip, or the provider still
// working through a load spike) a real chance to clear before the next try.
const NETWORK_ERROR_RETRY_DELAY_MS = 500;

let networkRetryDelayOverride: ((ms: number) => Promise<void>) | null = null;

/** Test-only: replace the real delay with something synchronous/instant. */
export function __setNetworkRetryDelayForTests(fn: ((ms: number) => Promise<void>) | null): void {
  networkRetryDelayOverride = fn;
}

function networkRetryDelay(ms: number): Promise<void> {
  if (networkRetryDelayOverride) return networkRetryDelayOverride(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one provider through its key pool, applying the per-key error taxonomy.
 * Throws the last error when every candidate is exhausted; the caller decides
 * whether a fallback provider exists.
 */
async function invokeProviderWithPool(
  store: ProviderCommandStore,
  target: InvocationTarget,
  body: ProviderChatRequestBody,
  attribution: UsageAttribution,
): Promise<ProviderChatResponseBody> {
  if (target.candidates.length === 0) {
    throw new ProviderInvocationError(
      503,
      `ModelProvider '${target.provider.id}' has no available credential (all keys cooling down)`,
    );
  }

  let lastError: unknown = null;
  let attempts = 0;
  for (const candidate of target.candidates) {
    if (
      candidate.credential_kind === "subscription_oauth"
      && (!body.metering.subject_user_id
        || body.metering.subject_user_id !== target.provider.owner_user_id)
    ) {
      throw new ProviderInvocationError(
        403,
        "Managed subscription capacity is restricted to its instance-admin owner",
        { failure_class: "permanent", actions: ["fail"] },
        "subscription_owner_required",
      );
    }
    let sameKeyRetries = 0;
    for (;;) {
      attempts += 1;
      let emittedText = false;
      const attemptBody = body.on_text_delta
        ? {
            ...body,
            on_text_delta: (delta: string) => {
              emittedText = true;
              body.on_text_delta?.(delta);
            },
          }
        : body;
      const providerTask = await beginProviderTaskAttempt(store, target, body.metering, {
        eventType: "llm.generation",
        model: body.model ?? target.provider.default_model,
        input: {
          system: body.system ?? null,
          messages: body.messages,
          tools: body.tools ?? null,
          output_format: body.output_format ?? null,
          max_tokens: body.max_tokens ?? null,
        },
      });
      try {
        const result = await attemptOnce(target, candidate.api_key, attemptBody);
        if (candidate.member_id) {
          await store.recordPoolOutcome(candidate.member_id, { kind: "success" });
        }
        await recordProviderUsage(store, target, {
          spaceId: target.provider.space_id,
          eventType: "llm.generation",
          model: result.model,
          usage: result.usage,
          cost: result.cost,
          costAccuracy: result.cost_accuracy,
          metering: meteringWithProviderTaskRefs(body.metering, providerTask),
          attribution,
        });
        await completeProviderTaskAttempt(store, providerTask, "accepted", null);
        return result;
      } catch (error) {
        await completeProviderTaskAttempt(store, providerTask, "failed", providerErrorCode(error));
        await recordFailedProviderAttemptUsage(store, target, {
          eventType: "llm.generation",
          model: body.model ?? target.provider.default_model,
          metering: body.metering,
          attribution,
          refs: providerTask,
          error,
        });
        if (emittedText) {
          throw new ProviderInvocationError(
            502,
            "Provider stream ended after partial output was delivered",
            { failure_class: "permanent", actions: ["fail"] },
            "provider_stream_interrupted",
          );
        }
        lastError = error;
        if (error instanceof ProviderInvocationError) error.attempts = attempts;
        if (!(error instanceof ProviderInvocationError) || !error.resilience) {
          // Permanent request-shaped errors (and non-taxonomy errors) do not
          // rotate: another key would fail the same way.
          throw error;
        }
        const decision = error.resilience;
        if (decision.failure_class === "permanent") {
          await recordFailure(store, candidate, decision);
          throw error;
        }
        const isNetworkError = error.code === "provider_network_error";
        const retryLimit = isNetworkError ? MAX_NETWORK_ERROR_RETRIES : MAX_SAME_KEY_RETRIES;
        if (
          (decision.failure_class === "rate_limit" || decision.failure_class === "transient") &&
          sameKeyRetries < retryLimit
        ) {
          sameKeyRetries += 1;
          if (isNetworkError) await networkRetryDelay(NETWORK_ERROR_RETRY_DELAY_MS * sameKeyRetries);
          continue;
        }
        await recordFailure(store, candidate, decision);
        if (decision.failure_class === "transient") {
          // Provider-side failure: other keys of the same provider won't
          // help. Hand over to the provider fallback layer.
          throw error;
        }
        break; // rotate to the next key
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ProviderInvocationError(502, "Provider invocation failed");
}

/**
 * Provider-level fallback (Hermes layer 2): the requested provider first,
 * then its configured `fallback_provider_ids` in order. Stateless per
 * request — a later request always restarts on the primary.
 */
export async function completeProviderChat(
  store: ProviderCommandStore,
  spaceId: string,
  body: ProviderChatRequestBody,
): Promise<ProviderChatInvocationResult> {
  assertMeteringContext(body.metering);
  const attribution = await resolveProviderUsageAttribution(
    store,
    spaceId,
    "llm.generation",
    body.metering,
  );
  const primary = await store.getInvocationTarget(
    spaceId,
    body.provider_id,
    body.metering.subject_user_id,
  );
  if (body.output_format && !providerSupportsStructuredOutput(primary.provider.provider_type)) {
    throw structuredOutputUnsupportedError(primary.provider.provider_type);
  }
  const chain: InvocationTarget[] = [primary];
  for (const fallbackId of body.allow_provider_fallback === false ? [] : primary.fallback_provider_ids) {
    try {
      chain.push(await store.getInvocationTarget(
        spaceId,
        fallbackId,
        body.metering.subject_user_id,
      ));
    } catch {
      // A missing/disabled fallback provider is skipped, not fatal.
    }
  }

  let lastError: unknown = null;
  for (const [index, target] of chain.entries()) {
    if (!providerTargetEgressAllowed(target, body.egressPolicy)) {
      lastError = providerEgressDeniedError(target);
      continue;
    }
    try {
      // Fallback providers serve THEIR OWN default model: an explicit model
      // name from the request only binds to the provider it was meant for.
      const effectiveBody = index === 0 ? body : { ...body, model: null };
      try {
        const result = await invokeProviderWithPool(store, target, effectiveBody, attribution);
        return { ...result, provider_id: target.provider.id };
      } catch (error) {
        // Weak instruction followers often fix their JSON when shown the
        // exact validation failure; one corrective round-trip is far cheaper
        // than failing the whole task.
        const corrective = structuredOutputCorrectionBody(effectiveBody, error);
        if (!corrective) throw error;
        const corrected = await invokeProviderWithPool(store, target, corrective, attribution);
        return { ...corrected, provider_id: target.provider.id };
      }
    } catch (error) {
      if (isUsageMeteringFailure(error)) throw error;
      lastError = error;
      if (
        error instanceof ProviderInvocationError &&
        error.resilience?.failure_class === "permanent"
      ) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ProviderInvocationError(502, "Provider invocation failed");
}

function structuredOutputCorrectionBody(
  body: ProviderChatRequestBody,
  error: unknown,
): ProviderChatRequestBody | null {
  if (!body.output_format) return null;
  if (!(error instanceof ProviderInvocationError) || error.code !== "structured_output_invalid") return null;
  const failurePoint = /failed schema '[^']*' at ([^(]+?)(?:\s*\(|$)/.exec(error.message)?.[1]?.trim();
  const requiredKeys = Array.isArray(body.output_format.schema.required)
    ? body.output_format.schema.required.filter((key): key is string => typeof key === "string")
    : [];
  const offending = typeof error.responseText === "string" && error.responseText.trim()
    ? error.responseText.slice(0, 6000)
    : null;
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: offending ?? "(previous structured reply was rejected)" },
      {
        role: "user",
        content: [
          `Your previous reply failed JSON schema validation for '${body.output_format.schema_id}'${failurePoint ? ` at ${failurePoint}` : ""}.`,
          requiredKeys.length ? `The top-level JSON object must contain exactly these keys: ${requiredKeys.join(", ")}.` : null,
          "Respond again with ONLY the corrected JSON object. Match every key name exactly as the schema spells it, including case; do not rename keys, do not wrap the object in another key, and do not add keys the schema does not declare.",
        ].filter(Boolean).join(" "),
      },
    ],
  };
}

export interface ProviderTextCompletionInput {
  provider_id: string;
  model?: string | null;
  system: string;
  user: string;
  max_tokens?: number;
  /** Auxiliary-task name; resolves a ProviderTaskPolicy chain when present. */
  task?: string | null;
  egressPolicy?: RetrievalEgressPolicy | null;
  metering: ProviderMeteringContext;
}

export interface ProviderMessagesCompletionInput {
  provider_id: string;
  model?: string | null;
  system?: string | null;
  messages: ChatMessage[];
  max_tokens?: number;
  tools?: CanonicalToolDefinition[] | null;
  output_format?: ProviderStructuredOutput | null;
  cache_strategy?: "conversation";
  on_text_delta?: (delta: string) => void;
  abort_signal?: AbortSignal;
  /** Auxiliary-task name; resolves a ProviderTaskPolicy chain when present. */
  task?: string | null;
  egressPolicy?: RetrievalEgressPolicy | null;
  allow_provider_fallback?: boolean;
  metering: ProviderMeteringContext;
}

/**
 * Auxiliary-task completion. When the space holds an enabled
 * ProviderTaskPolicy for `task`, its chain is walked first (each entry with
 * full key-pool resilience); the caller's provider acts as the safety net.
 * Without a policy this degrades to a plain provider-chat completion.
 */
export async function completeProviderText(
  store: ProviderCommandStore,
  spaceId: string,
  input: ProviderTextCompletionInput,
): Promise<{ text: string; provider: string; model: string; usage: Record<string, unknown> }> {
  return completeProviderMessages(store, spaceId, {
    provider_id: input.provider_id,
    model: input.model,
    system: input.system,
    messages: [{ role: "user", content: input.user }],
    max_tokens: input.max_tokens,
    task: input.task,
    egressPolicy: input.egressPolicy,
    metering: input.metering,
  });
}

export async function completeProviderMessages(
  store: ProviderCommandStore,
  spaceId: string,
  input: ProviderMessagesCompletionInput,
): Promise<{
  text: string;
  provider: string;
  provider_id: string;
  model: string;
  usage: Record<string, unknown>;
  tool_calls?: CanonicalToolCall[];
  structured_output?: Record<string, unknown> | null;
  finish_reason?: string | null;
}> {
  const chatBody = (providerId: string, model: string | null | undefined): ProviderChatRequestBody => ({
    provider_id: providerId,
    model,
    system: input.system,
    messages: input.messages,
    max_tokens: input.max_tokens,
    tools: input.tools,
    output_format: input.output_format,
    cache_strategy: input.cache_strategy,
    on_text_delta: input.on_text_delta,
    abort_signal: input.abort_signal,
    egressPolicy: input.egressPolicy,
    allow_provider_fallback: input.allow_provider_fallback,
    metering: meteringContext(input.metering, input.task),
  });

  // A structured contract is bound to the selected Research provider/model.
  // Auxiliary task policies may intentionally reroute generic work, but they
  // must not silently replace a Research execution contract.
  const taskChain = input.output_format || !input.task || input.allow_provider_fallback === false
    ? null
    : await store.getTaskChain(spaceId, input.task);
  let lastError: unknown = null;
  if (taskChain) {
    for (const entry of taskChain) {
      try {
        const result = await completeProviderChat(store, spaceId, chatBody(entry.provider_id, entry.model));
        return {
          text: result.content,
          provider: result.provider,
          provider_id: result.provider_id,
          model: result.model,
          usage: result.usage,
          tool_calls: result.tool_calls,
          structured_output: result.structured_output,
          finish_reason: result.finish_reason,
        };
      } catch (error) {
        if (isUsageMeteringFailure(error)) throw error;
        lastError = error;
        if (
          error instanceof ProviderInvocationError &&
          error.resilience?.failure_class === "permanent"
        ) {
          throw error;
        }
      }
    }
    // Safety net: the caller's provider, unless the chain already tried it.
    if (taskChain.some((entry) => entry.provider_id === input.provider_id)) {
      throw lastError instanceof Error
        ? lastError
        : new ProviderInvocationError(502, "Provider invocation failed");
    }
  }

  const result = await completeProviderChat(store, spaceId, chatBody(input.provider_id, input.model));
  return {
    text: result.content,
    provider: result.provider,
    provider_id: result.provider_id,
    model: result.model,
    usage: result.usage,
    tool_calls: result.tool_calls,
    structured_output: result.structured_output,
    finish_reason: result.finish_reason,
  };
}

export interface ProviderEmbeddingInput {
  /** Caller's own provider; used as the safety net after any task chain. */
  provider_id?: string | null;
  model?: string | null;
  inputs: string[];
  /** Normalized embedding dimension intent; provider adapters map or validate it. */
  dimensions?: number | null;
  /** Retrieval embedding input type for providers that distinguish queries from documents. */
  inputType?: "query" | "document";
  /** Auxiliary task whose ProviderTaskPolicy chain is tried first (e.g. retrieval_embedding). */
  task?: string;
  egressPolicy?: RetrievalEgressPolicy | null;
  metering: ProviderMeteringContext;
}

export interface ProviderEmbeddingResult {
  vectors: number[][];
  model: string;
  usage: Record<string, unknown>;
}

export interface ProviderRerankInput {
  /** Caller's own provider; used as the safety net after any task chain. */
  provider_id?: string | null;
  model?: string | null;
  query: string;
  documents: string[];
  /** Provider-side top_n; defaults to all documents. */
  topN?: number | null;
  /** Auxiliary task whose ProviderTaskPolicy chain is tried first. */
  task?: string;
  egressPolicy?: RetrievalEgressPolicy | null;
  metering: ProviderMeteringContext;
}

export interface ProviderRerankResult {
  scores: Array<{ index: number; score: number }>;
  model: string;
  usage: Record<string, unknown>;
}

/**
 * Auxiliary embeddings completion. Mirrors `completeProviderText`'s task-chain
 * resilience: the `task` policy chain is tried first, then the caller's
 * provider as a safety net. Supports OpenAI-compatible `/embeddings`, Ollama
 * `/api/embed`, ZeroEntropy `/models/embed`, and Cohere `/v2/embed`; provider
 * types without an embeddings endpoint fail closed.
 */
export async function completeProviderEmbedding(
  store: ProviderCommandStore,
  spaceId: string,
  input: ProviderEmbeddingInput,
): Promise<ProviderEmbeddingResult> {
  if (input.inputs.length === 0) return { vectors: [], model: "", usage: {} };
  assertMeteringContext(input.metering);
  const attribution = await resolveProviderUsageAttribution(
    store,
    spaceId,
    "llm.embedding",
    input.metering,
  );
  const taskChain = input.task ? await store.getTaskChain(spaceId, input.task) : null;
  if (taskChain) {
    let lastError: unknown = null;
    for (const entry of taskChain) {
      try {
        return await completeProviderEmbeddingWithFallback(
          store,
          spaceId,
          entry.provider_id,
          entry.model,
          input.inputs,
          input.dimensions,
          input.inputType,
          input.egressPolicy,
          meteringContext(input.metering, input.task),
          attribution,
        );
      } catch (error) {
        if (isUsageMeteringFailure(error)) throw error;
        lastError = error;
        if (
          error instanceof ProviderInvocationError &&
          error.resilience?.failure_class === "permanent"
        ) {
          throw error;
        }
      }
    }
    if (taskChain.some((entry) => entry.provider_id === input.provider_id)) {
      throw lastError instanceof Error
        ? lastError
        : new ProviderInvocationError(502, "Embedding invocation failed");
    }
  }

  return completeProviderEmbeddingWithFallback(
    store,
    spaceId,
    input.provider_id ?? null,
    input.model,
    input.inputs,
    input.dimensions,
    input.inputType,
    input.egressPolicy,
    meteringContext(input.metering, input.task),
    attribution,
  );
}

async function completeProviderEmbeddingWithFallback(
  store: ProviderCommandStore,
  spaceId: string,
  providerId: string | null | undefined,
  model: string | null | undefined,
  inputs: string[],
  dimensions?: number | null,
  inputType?: "query" | "document",
  egressPolicy?: RetrievalEgressPolicy | null,
  metering?: ProviderMeteringContext | null,
  attribution?: UsageAttribution,
): Promise<ProviderEmbeddingResult> {
  const target = await store.getInvocationTarget(spaceId, providerId, metering?.subject_user_id);
  const chain: InvocationTarget[] = [target];
  for (const fallbackId of target.fallback_provider_ids) {
    try {
      chain.push(await store.getInvocationTarget(spaceId, fallbackId, metering?.subject_user_id));
    } catch {
      // A missing/disabled fallback provider is skipped, matching chat behavior.
    }
  }

  let lastError: unknown = null;
  for (const [index, candidate] of chain.entries()) {
    if (!providerTargetEgressAllowed(candidate, egressPolicy)) {
      lastError = providerEgressDeniedError(candidate);
      continue;
    }
    try {
      return await invokeEmbeddingProviderWithPool(
        store,
        candidate,
        index === 0 ? model : null,
        inputs,
        dimensions,
        inputType,
        metering,
        attribution,
      );
    } catch (error) {
      if (isUsageMeteringFailure(error)) throw error;
      lastError = error;
      if (
        error instanceof ProviderInvocationError &&
        error.resilience?.failure_class === "permanent"
      ) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ProviderInvocationError(502, "Embedding invocation failed");
}

async function invokeEmbeddingProviderWithPool(
  store: ProviderCommandStore,
  target: InvocationTarget,
  model: string | null | undefined,
  inputs: string[],
  dimensions?: number | null,
  inputType?: "query" | "document",
  metering?: ProviderMeteringContext | null,
  attribution?: UsageAttribution,
): Promise<ProviderEmbeddingResult> {
  if (target.candidates.length === 0) {
    throw new ProviderInvocationError(
      503,
      `ModelProvider '${target.provider.id}' has no available credential (all keys cooling down)`,
    );
  }

  let lastError: unknown = null;
  for (const candidate of target.candidates) {
    let retriedSameKey = false;
    for (;;) {
      const providerTask = await beginProviderTaskAttempt(store, target, metering ?? {}, {
        eventType: "llm.embedding",
        model: model ?? target.provider.default_model,
        input: { inputs, dimensions: dimensions ?? null, input_type: inputType ?? null },
      });
      try {
        const result = await embedOnce(target, candidate.api_key, model, inputs, dimensions, inputType);
        if (candidate.member_id) {
          await store.recordPoolOutcome(candidate.member_id, { kind: "success" });
        }
        await recordProviderUsage(store, target, {
          spaceId: target.provider.space_id,
          eventType: "llm.embedding",
          model: result.model,
          usage: result.usage,
          metering: meteringWithProviderTaskRefs(metering ?? {}, providerTask),
          attribution: requiredAttribution(attribution),
        });
        await completeProviderTaskAttempt(store, providerTask, "accepted", null);
        return result;
      } catch (error) {
        await completeProviderTaskAttempt(store, providerTask, "failed", providerErrorCode(error));
        await recordFailedProviderAttemptUsage(store, target, {
          eventType: "llm.embedding",
          model: model ?? target.provider.default_model,
          metering: metering ?? {},
          attribution: requiredAttribution(attribution),
          refs: providerTask,
          error,
        });
        lastError = error;
        if (!(error instanceof ProviderInvocationError) || !error.resilience) {
          throw error;
        }
        const decision = error.resilience;
        if (decision.failure_class === "permanent") {
          await recordFailure(store, candidate, decision);
          throw error;
        }
        if (
          (decision.failure_class === "rate_limit" || decision.failure_class === "transient") &&
          !retriedSameKey
        ) {
          retriedSameKey = true;
          continue;
        }
        await recordFailure(store, candidate, decision);
        if (decision.failure_class === "transient") {
          throw error;
        }
        break;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ProviderInvocationError(502, "Embedding invocation failed");
}

async function embedOnce(
  target: InvocationTarget,
  apiKey: string | null,
  model: string | null | undefined,
  inputs: string[],
  dimensions?: number | null,
  inputType?: "query" | "document",
): Promise<ProviderEmbeddingResult> {
  const provider = target.provider;
  const resolvedModel = bareModelName(provider.provider_type, resolveModel(provider, model));

  if (provider.provider_type === "ollama") {
    const base = provider.base_url?.replace(/\/+$/, "");
    if (!base) throw new ProviderInvocationError(400, "base_url is required for provider_type 'ollama'");
    const response = await fetchProviderResponse(target.network_profile, `${base}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: resolvedModel, input: inputs }),
    });
    const data = (await parseJsonResponse(response)) as {
      embeddings?: number[][];
      model?: string;
      prompt_eval_count?: number;
      usage?: Record<string, unknown>;
    };
    return {
      vectors: data.embeddings ?? [],
      model: data.model ?? resolvedModel,
      usage: data.usage ??
        (typeof data.prompt_eval_count === "number" ? { input_tokens: data.prompt_eval_count } : {}),
    };
  }

  if (provider.provider_type === "zeroentropy") {
    if (!apiKey) {
      throw new ProviderInvocationError(400, `ModelProvider '${provider.id}' has no API key credential`);
    }
    const base = provider.base_url?.replace(/\/+$/, "");
    if (!base) throw new ProviderInvocationError(400, "base_url is required for provider_type 'zeroentropy'");
    const body: Record<string, unknown> = {
      model: resolvedModel,
      input: inputs,
      input_type: inputType ?? "document",
      encoding_format: "float",
    };
    if (typeof dimensions === "number" && Number.isInteger(dimensions) && dimensions > 0) {
      body.dimensions = dimensions;
    }
    const response = await fetchProviderResponse(target.network_profile, `${base}/models/embed`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = (await parseJsonResponse(response)) as {
      results?: Array<{ embedding?: number[] }>;
      usage?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    };
    return {
      vectors: (data.results ?? []).map((row) => row.embedding ?? []),
      model: resolvedModel,
      usage: data.usage ?? data.meta ?? {},
    };
  }

  if (provider.provider_type === "cohere") {
    if (!apiKey) {
      throw new ProviderInvocationError(400, `ModelProvider '${provider.id}' has no API key credential`);
    }
    const vectors: number[][] = [];
    let usage: Record<string, unknown> = {};
    for (const batch of batches(inputs, 96)) {
      const body: Record<string, unknown> = {
        model: resolvedModel,
        texts: batch,
        input_type: inputType === "query" ? "search_query" : "search_document",
        embedding_types: ["float"],
        truncate: "END",
      };
      if (typeof dimensions === "number" && Number.isInteger(dimensions) && dimensions > 0) {
        if (![256, 512, 1024, 1536].includes(dimensions)) {
          throw new ProviderInvocationError(
            400,
            `provider_type 'cohere' supports output dimensions 256, 512, 1024, or 1536; got ${dimensions}`,
          );
        }
        body.output_dimension = dimensions;
      }
      const response = await fetchProviderResponse(target.network_profile, `${cohereV2Base(provider)}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const data = (await parseJsonResponse(response)) as {
        embeddings?: { float?: number[][] } | number[][];
        meta?: Record<string, unknown>;
      };
      vectors.push(...cohereFloatEmbeddings(data.embeddings));
      usage = mergeUsage(usage, data.meta);
    }
    return { vectors, model: resolvedModel, usage };
  }

  if (["openai", "openrouter", "openai_compatible"].includes(provider.provider_type)) {
    const vendor = providerVendor(provider.provider_type);
    if (!apiKey && vendor?.apiKeyRequired !== false) {
      throw new ProviderInvocationError(400, `ModelProvider '${provider.id}' has no API key credential`);
    }
    const body: Record<string, unknown> = { model: resolvedModel, input: inputs };
    if (typeof dimensions === "number" && Number.isInteger(dimensions) && dimensions > 0) {
      body.dimensions = dimensions;
    }
    const response = await fetchProviderResponse(target.network_profile, `${openAiBase(provider)}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = (await parseJsonResponse(response)) as {
      data?: Array<{ embedding: number[]; index?: number }>;
      model?: string;
      usage?: Record<string, unknown>;
    };
    const sorted = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return {
      vectors: sorted.map((row) => row.embedding),
      model: data.model ?? resolvedModel,
      usage: data.usage ?? {},
    };
  }

  throw new ProviderInvocationError(
    400,
    `provider_type '${provider.provider_type}' does not support embeddings`,
  );
}

/**
 * Auxiliary native rerank completion. This is intentionally separate from chat
 * completions because rerank providers expose a different request/response
 * contract and may not support generation.
 */
export async function completeProviderRerank(
  store: ProviderCommandStore,
  spaceId: string,
  input: ProviderRerankInput,
): Promise<ProviderRerankResult> {
  if (input.documents.length === 0) return { scores: [], model: "", usage: {} };
  assertMeteringContext(input.metering);
  const attribution = await resolveProviderUsageAttribution(
    store,
    spaceId,
    "llm.rerank",
    input.metering,
  );
  const taskChain = input.task ? await store.getTaskChain(spaceId, input.task) : null;
  if (taskChain) {
    let lastError: unknown = null;
    for (const entry of taskChain) {
      try {
        return await completeProviderRerankWithFallback(
          store,
          spaceId,
          entry.provider_id,
          entry.model,
          input.query,
          input.documents,
          input.topN,
          input.egressPolicy,
          meteringContext(input.metering, input.task),
          attribution,
        );
      } catch (error) {
        if (isUsageMeteringFailure(error)) throw error;
        lastError = error;
        if (
          error instanceof ProviderInvocationError &&
          error.resilience?.failure_class === "permanent"
        ) {
          throw error;
        }
      }
    }
    if (taskChain.some((entry) => entry.provider_id === input.provider_id)) {
      throw lastError instanceof Error
        ? lastError
        : new ProviderInvocationError(502, "Rerank invocation failed");
    }
  }

  return completeProviderRerankWithFallback(
    store,
    spaceId,
    input.provider_id ?? null,
    input.model,
    input.query,
    input.documents,
    input.topN,
    input.egressPolicy,
    meteringContext(input.metering, input.task),
    attribution,
  );
}

async function completeProviderRerankWithFallback(
  store: ProviderCommandStore,
  spaceId: string,
  providerId: string | null | undefined,
  model: string | null | undefined,
  query: string,
  documents: string[],
  topN?: number | null,
  egressPolicy?: RetrievalEgressPolicy | null,
  metering?: ProviderMeteringContext | null,
  attribution?: UsageAttribution,
): Promise<ProviderRerankResult> {
  const target = await store.getInvocationTarget(spaceId, providerId, metering?.subject_user_id);
  const chain: InvocationTarget[] = [target];
  for (const fallbackId of target.fallback_provider_ids) {
    try {
      chain.push(await store.getInvocationTarget(spaceId, fallbackId, metering?.subject_user_id));
    } catch {
      // A missing/disabled fallback provider is skipped, matching chat behavior.
    }
  }

  let lastError: unknown = null;
  for (const [index, candidate] of chain.entries()) {
    if (!providerTargetEgressAllowed(candidate, egressPolicy)) {
      lastError = providerEgressDeniedError(candidate);
      continue;
    }
    try {
      return await invokeRerankProviderWithPool(
        store,
        candidate,
        index === 0 ? model : null,
        query,
        documents,
        topN,
        metering,
        attribution,
      );
    } catch (error) {
      if (isUsageMeteringFailure(error)) throw error;
      lastError = error;
      if (
        error instanceof ProviderInvocationError &&
        error.resilience?.failure_class === "permanent"
      ) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ProviderInvocationError(502, "Rerank invocation failed");
}

async function invokeRerankProviderWithPool(
  store: ProviderCommandStore,
  target: InvocationTarget,
  model: string | null | undefined,
  query: string,
  documents: string[],
  topN?: number | null,
  metering?: ProviderMeteringContext | null,
  attribution?: UsageAttribution,
): Promise<ProviderRerankResult> {
  if (target.candidates.length === 0) {
    throw new ProviderInvocationError(
      503,
      `ModelProvider '${target.provider.id}' has no available credential (all keys cooling down)`,
    );
  }

  let lastError: unknown = null;
  for (const candidate of target.candidates) {
    let retriedSameKey = false;
    for (;;) {
      const providerTask = await beginProviderTaskAttempt(store, target, metering ?? {}, {
        eventType: "llm.rerank",
        model: model ?? target.provider.default_model,
        input: { query, documents, top_n: topN ?? null },
      });
      try {
        const result = await rerankOnce(target, candidate.api_key, model, query, documents, topN);
        if (candidate.member_id) {
          await store.recordPoolOutcome(candidate.member_id, { kind: "success" });
        }
        await recordProviderUsage(store, target, {
          spaceId: target.provider.space_id,
          eventType: "llm.rerank",
          model: result.model,
          usage: result.usage,
          metering: meteringWithProviderTaskRefs(metering ?? {}, providerTask),
          attribution: requiredAttribution(attribution),
        });
        await completeProviderTaskAttempt(store, providerTask, "accepted", null);
        return result;
      } catch (error) {
        await completeProviderTaskAttempt(store, providerTask, "failed", providerErrorCode(error));
        await recordFailedProviderAttemptUsage(store, target, {
          eventType: "llm.rerank",
          model: model ?? target.provider.default_model,
          metering: metering ?? {},
          attribution: requiredAttribution(attribution),
          refs: providerTask,
          error,
        });
        lastError = error;
        if (!(error instanceof ProviderInvocationError) || !error.resilience) {
          throw error;
        }
        const decision = error.resilience;
        if (decision.failure_class === "permanent") {
          await recordFailure(store, candidate, decision);
          throw error;
        }
        if (
          (decision.failure_class === "rate_limit" || decision.failure_class === "transient") &&
          !retriedSameKey
        ) {
          retriedSameKey = true;
          continue;
        }
        await recordFailure(store, candidate, decision);
        if (decision.failure_class === "transient") {
          throw error;
        }
        break;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ProviderInvocationError(502, "Rerank invocation failed");
}

async function rerankOnce(
  target: InvocationTarget,
  apiKey: string | null,
  model: string | null | undefined,
  query: string,
  documents: string[],
  topN?: number | null,
): Promise<ProviderRerankResult> {
  const provider = target.provider;

  if (provider.provider_type === "zeroentropy") {
    if (!apiKey) {
      throw new ProviderInvocationError(400, `ModelProvider '${provider.id}' has no API key credential`);
    }
    const base = provider.base_url?.replace(/\/+$/, "");
    if (!base) throw new ProviderInvocationError(400, "base_url is required for provider_type 'zeroentropy'");
    const resolvedModel = bareModelName("zeroentropy", model?.trim() || "zerank-2");
    const response = await fetchProviderResponse(target.network_profile, `${base}/models/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: resolvedModel,
        query,
        documents,
        top_n:
          typeof topN === "number" && Number.isInteger(topN) && topN > 0
            ? Math.min(topN, documents.length)
            : documents.length,
      }),
    });
    const data = (await parseJsonResponse(response)) as {
      results?: Array<{ index?: number; relevance_score?: number }>;
      total_bytes?: number;
      total_tokens?: number;
      e2e_latency?: number;
      inference_latency?: number;
    };
    return {
      scores: (data.results ?? [])
        .map((entry) => ({ index: Number(entry.index), score: Number(entry.relevance_score) }))
        .filter((entry) => Number.isInteger(entry.index) && Number.isFinite(entry.score)),
      model: resolvedModel,
      usage: {
        total_bytes: data.total_bytes,
        total_tokens: data.total_tokens,
        e2e_latency: data.e2e_latency,
        inference_latency: data.inference_latency,
      },
    };
  }

  if (provider.provider_type === "cohere") {
    if (!apiKey) {
      throw new ProviderInvocationError(400, `ModelProvider '${provider.id}' has no API key credential`);
    }
    const resolvedModel = bareModelName("cohere", model?.trim() || "rerank-v4.0-pro");
    const response = await fetchProviderResponse(target.network_profile, `${cohereV2Base(provider)}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: resolvedModel,
        query,
        documents,
        top_n:
          typeof topN === "number" && Number.isInteger(topN) && topN > 0
            ? Math.min(topN, documents.length)
            : documents.length,
      }),
    });
    const data = (await parseJsonResponse(response)) as {
      results?: Array<{ index?: number; relevance_score?: number }>;
      meta?: Record<string, unknown>;
    };
    return {
      scores: (data.results ?? [])
        .map((entry) => ({ index: Number(entry.index), score: Number(entry.relevance_score) }))
        .filter((entry) => Number.isInteger(entry.index) && Number.isFinite(entry.score)),
      model: resolvedModel,
      usage: data.meta ?? {},
    };
  }

  throw new ProviderInvocationError(
    400,
    `provider_type '${provider.provider_type}' does not support native rerank`,
  );
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function cohereFloatEmbeddings(value: unknown): number[][] {
  if (Array.isArray(value)) return value.filter(isNumberArray);
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const floats = (value as { float?: unknown }).float;
  return Array.isArray(floats) ? floats.filter(isNumberArray) : [];
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

export async function listProviderModels(
  store: ProviderCommandStore,
  spaceId: string,
  providerId: string,
  subjectUserId?: string | null,
): Promise<{ models: string[]; source: "configured" | "live" }> {
  const configured = await store.listConfiguredModels(spaceId, providerId);
  if (configured.length > 0) return { models: configured, source: "configured" };
  const target = await store.getInvocationTarget(spaceId, providerId, subjectUserId);
  const provider = target.provider;
  const apiKey = target.candidates.find((c) => c.api_key)?.api_key ?? null;
  if (provider.provider_type === "ollama" && provider.base_url) {
    const data = (await parseJsonResponse(
      await fetchProviderResponse(target.network_profile, `${provider.base_url.replace(/\/+$/, "")}/api/tags`),
    )) as { models?: Array<{ name?: string }> };
    return {
      models: (data.models ?? []).map((m) => m.name).filter((m): m is string => Boolean(m)),
      source: "live",
    };
  }
  if (["openai", "openrouter", "openai_compatible"].includes(provider.provider_type)) {
    const headers: Record<string, string> = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const data = (await parseJsonResponse(
      await fetchProviderResponse(target.network_profile, `${openAiBase(provider)}/models`, { headers }),
    )) as { data?: Array<{ id?: string }> };
    return {
      models: (data.data ?? []).map((m) => m.id).filter((m): m is string => Boolean(m)),
      source: "live",
    };
  }
  return { models: [], source: "configured" };
}
