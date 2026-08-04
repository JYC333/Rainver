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
 *   3. Task chain — auxiliary tasks (reflector, condenser, …) may carry a
 *                   ProviderTaskPolicy chain that takes precedence over the
 *                   caller's provider, which then acts as the safety net.
 *
 * API keys are passed as request parameters/headers only. They are never
 * written to process env and never returned in responses.
 */

import type {
  CanonicalToolCall,
  CanonicalToolDefinition,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type {
  InvocationTarget,
  PoolKeyCandidate,
  ProviderCommandStore,
  ProviderInfo,
} from "../commands/store";
import type { UsageAttribution, UsageObservation } from "../../usage";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { classifyProviderFailure, type ProviderResilienceDecision } from "./resilience";
import { fetchWithNetworkProfile, type ResolvedNetworkProfile } from "../../networkProfiles";
import {
  anthropicMessages,
  anthropicToolCalls,
  anthropicTools,
  openAiMessages,
  openAiToolCalls,
  openAiTools,
} from "./toolAdapters";
import {
  retrievalEgressAllowed,
  retrievalProviderEgressDestination,
  type RetrievalEgressPolicy,
} from "../../retrieval/egress/egressPolicy";
import { normalizeGatewayShapes, normalizeNullableNearMisses, validateStructuredOutput } from "../../runs/structuredOutputValidation";
import { providerSupportsStructuredOutput, structuredOutputToolStrategy } from "../structuredOutputCapabilities";
import { effectiveMaxOutputTokens } from "../modelOutputLimits";

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
  metering: ProviderMeteringContext;
}

export interface ProviderChatResponseBody {
  content: string;
  provider: string;
  model: string;
  usage: Record<string, unknown>;
  tool_calls?: CanonicalToolCall[];
  structured_output?: Record<string, unknown> | null;
  finish_reason?: string | null;
}

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

export function buildProviderModelName(providerType: string, model: string): string {
  if (model.includes("/")) return model;
  if (providerType === "anthropic") return `anthropic/${model}`;
  if (providerType === "openrouter") return `openrouter/${model}`;
  if (providerType === "ollama") return `ollama/${model}`;
  return `openai/${model}`;
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
  if (["openai", "other"].includes(providerType) && model.startsWith("openai/")) {
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

async function assertStreamingResponseOk(response: Response): Promise<void> {
  if (response.ok) return;
  const text = await response.text();
  const decision = classifyProviderFailure(response.status, text);
  throw new ProviderInvocationError(
    502,
    `Provider request failed with status ${response.status}`,
    decision,
    decision.failure_class === "rate_limit" ? "provider_rate_limit" : undefined,
  );
}

async function* responseLines(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    throw new ProviderInvocationError(502, "Provider returned no response stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) yield line;
      if (done) break;
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

function jsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function openAiBase(provider: ProviderInfo): string {
  if (provider.base_url) return provider.base_url.replace(/\/+$/, "");
  if (provider.provider_type === "openrouter") return "https://openrouter.ai/api/v1";
  return "https://api.openai.com/v1";
}

function openAiCompatibleBase(provider: ProviderInfo): string {
  if (provider.provider_type === "anthropic" && provider.openai_compatible_base_url) {
    return provider.openai_compatible_base_url.replace(/\/+$/, "");
  }
  return openAiBase(provider);
}

function anthropicMessagesUrl(provider: ProviderInfo): string {
  const base = (provider.base_url || "https://api.anthropic.com").replace(/\/+$/, "");
  const versioned = base.endsWith("/v1") ? base : `${base}/v1`;
  return `${versioned}/messages`;
}

function cohereV2Base(provider: ProviderInfo): string {
  const base = (provider.base_url || "https://api.cohere.com").replace(/\/+$/, "");
  return base.endsWith("/v2") ? base : `${base}/v2`;
}

function providerSupportsRuntimeTools(providerType: string): boolean {
  return (
    providerType === "openai" ||
    providerType === "openrouter" ||
    providerType === "other" ||
    providerType === "anthropic"
  );
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

function providerStructuredOutputName(schemaId: string): string {
  return schemaId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "structured_output";
}

// ---------------------------------------------------------------------------
// Single-attempt provider calls (one key, one request)
// ---------------------------------------------------------------------------

async function completeOpenAiCompatible(
  provider: ProviderInfo,
  networkProfile: ResolvedNetworkProfile | null,
  apiKey: string | null,
  body: ProviderChatRequestBody,
): Promise<ProviderChatResponseBody> {
  if (!apiKey) {
    throw new ProviderInvocationError(
      400,
      `ModelProvider '${provider.id}' has no API key credential`,
    );
  }
  const model = bareModelName(provider.provider_type, resolveModel(provider, body.model));
  const tools = openAiTools(body.tools);
  // `response_format: json_schema` needs provider-side constrained decoding;
  // OpenAI-compatible gateways that lack it silently ignore the field and
  // answer in prose. Models are far more reliably trained to emit valid JSON
  // as tool-call arguments, so when the request has no runtime tools of its
  // own, also offer the schema as a single forced tool. Providers honoring
  // response_format still constrain the output; the ones ignoring it return
  // the payload as tool arguments, which the response path already prefers
  // (structuredOutputFromOpenAiChoice checks the schema-named tool first).
  const structuredToolName = body.output_format ? providerStructuredOutputName(body.output_format.schema_id) : null;
  const structuredStrategy = structuredOutputToolStrategy(model, body.output_format?.schema);
  const forcedStructuredTool = body.output_format && !tools && structuredStrategy.forceTool
    ? [{
        type: "function",
        function: {
          name: structuredToolName!,
          description: `Return the ${body.output_format.schema_id} structured result.`,
          parameters: body.output_format.schema,
        },
      }]
    : null;
  // A model that neither honors response_format nor gets the forced tool
  // otherwise NEVER sees the contract — it can only guess field shapes from
  // prose. Embed the schema itself in the system instruction for those.
  const schemaInstruction = structuredStrategy.schemaInstruction;
  const messagesBody = schemaInstruction
    ? { ...body, system: body.system ? `${body.system}\n\n${schemaInstruction}` : schemaInstruction }
    : body;
  const streaming = Boolean(body.on_text_delta) && !body.output_format && !body.tools?.length;
  const response = await fetchProviderResponse(networkProfile, `${openAiCompatibleBase(provider)}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: openAiMessages(messagesBody),
      temperature: body.temperature,
      max_tokens: effectiveMaxOutputTokens(model, body.max_tokens) ?? undefined,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
      ...(forcedStructuredTool ? {
        tools: forcedStructuredTool,
        tool_choice: { type: "function", function: { name: structuredToolName } },
      } : {}),
      ...(body.output_format ? {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: providerStructuredOutputName(body.output_format.schema_id),
            strict: body.output_format.strict ?? true,
            schema: body.output_format.schema,
          },
        },
      } : {}),
      ...(streaming ? {
        stream: true,
        stream_options: { include_usage: true },
      } : {}),
    }),
    signal: body.abort_signal,
  });
  if (streaming) {
    return completeOpenAiStream(response, provider.provider_type, model, body.on_text_delta!);
  }
  const data = (await parseJsonResponse(response)) as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    model?: string;
    usage?: Record<string, unknown>;
  };
  const choice = data.choices?.[0];
  const toolCalls = openAiToolCalls(choice?.message?.tool_calls, body.tools);
  const content = choice?.message?.content ?? "";
  const structuredDiagnostics = {
    transport: "openai_compatible",
    finish_reason: choice?.finish_reason ?? "unknown",
    response_model: data.model ?? model,
    choice_count: data.choices?.length ?? 0,
    content_type: choice?.message?.content === null
      ? "null"
      : Array.isArray(choice?.message?.content)
        ? "array"
        : typeof choice?.message?.content,
    tool_call_count: choice?.message?.tool_calls?.length ?? 0,
    tool_names: (choice?.message?.tool_calls ?? [])
      .map((call) => call.function?.name ?? "unnamed")
      .slice(0, 8),
    tool_argument_lengths: (choice?.message?.tool_calls ?? [])
      .map((call) => typeof call.function?.arguments === "string" ? call.function.arguments.length : 0)
      .slice(0, 8),
  } satisfies StructuredOutputDiagnostics;
  const structuredOutput = body.output_format
    ? (() => {
        try {
          return structuredOutputFromOpenAiChoice(
            choice,
            body.output_format,
            content,
            !body.tools?.length,
            structuredDiagnostics,
          );
        } catch (error) {
          if (error instanceof ProviderInvocationError && error.code === "structured_output_invalid") {
            // The schema failure usually lives in tool-call arguments, not the
            // message text; carry both so the failure logger shows the actual
            // offending payload instead of only the reasoning prose.
            const rawToolCalls = (choice?.message?.tool_calls ?? [])
              .filter((call) => typeof call.function?.arguments === "string" && call.function.arguments)
              .map((call) => `tool_call ${call.function?.name ?? "unnamed"} arguments: ${call.function!.arguments}`);
            throw new ProviderInvocationError(
              error.statusCode,
              error.message,
              error.resilience,
              error.code,
              error.diagnostics,
              [content, ...rawToolCalls].filter(Boolean).join("\n"),
            );
          }
          throw error;
        }
      })()
    : null;
  return {
    content,
    provider: provider.provider_type,
    model: data.model ?? model,
    usage: data.usage ?? {},
    tool_calls: toolCalls,
    structured_output: structuredOutput,
    finish_reason: choice?.finish_reason ?? null,
  };
}

async function completeOpenAiStream(
  response: Response,
  providerType: string,
  requestedModel: string,
  onTextDelta: (delta: string) => void,
): Promise<ProviderChatResponseBody> {
  await assertStreamingResponseOk(response);
  let content = "";
  let model = requestedModel;
  let usage: Record<string, unknown> = {};
  let finishReason: string | null = null;
  let terminated = false;
  for await (const line of responseLines(response)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      terminated = true;
      continue;
    }
    const event = jsonRecord(payload);
    if (!event) continue;
    const eventModel = stringField(event, "model");
    if (eventModel) model = eventModel;
    if (isRecord(event.usage)) usage = event.usage;
    const choice = Array.isArray(event.choices) && isRecord(event.choices[0])
      ? event.choices[0]
      : null;
    const delta = choice && isRecord(choice.delta)
      ? stringField(choice.delta, "content")
      : null;
    if (delta) {
      content += delta;
      onTextDelta(delta);
    }
    const reason = choice ? stringField(choice, "finish_reason") : null;
    if (reason) finishReason = reason;
  }
  if (!terminated) throw interruptedProviderStreamError();
  return {
    content,
    provider: providerType,
    model,
    usage,
    structured_output: null,
    finish_reason: finishReason,
  };
}

function structuredOutputFromOpenAiChoice(
  choice: {
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  } | undefined,
  outputFormat: ProviderStructuredOutput,
  content: unknown,
  allowUnlabelledToolCall: boolean,
  diagnostics: StructuredOutputDiagnostics,
): Record<string, unknown> {
  const expectedName = providerStructuredOutputName(outputFormat.schema_id);
  const toolCalls = choice?.message?.tool_calls ?? [];
  const expectedTool = toolCalls.find((call) => call.function?.name === expectedName)
    ?? (allowUnlabelledToolCall && toolCalls.length === 1 ? toolCalls[0] : undefined);
  if (expectedTool?.function?.arguments) {
    return structuredOutputFromText(expectedTool.function.arguments, outputFormat, {
      ...diagnostics,
      response_kind: "tool_call_arguments",
    });
  }
  return structuredOutputFromText(content, outputFormat, {
    ...diagnostics,
    response_kind: "message_content",
  });
}

async function completeAnthropic(
  provider: ProviderInfo,
  networkProfile: ResolvedNetworkProfile | null,
  apiKey: string | null,
  body: ProviderChatRequestBody,
): Promise<ProviderChatResponseBody> {
  if (!apiKey) {
    throw new ProviderInvocationError(
      400,
      `ModelProvider '${provider.id}' has no API key credential`,
    );
  }
  const model = bareModelName("anthropic", resolveModel(provider, body.model));
  const structuredStrategy = structuredOutputToolStrategy(model, body.output_format?.schema);
  const structuredDefinition: CanonicalToolDefinition[] = body.output_format && structuredStrategy.forceTool
    ? [{
        name: providerStructuredOutputName(body.output_format.schema_id),
        description: `Return the ${body.output_format.schema_id} structured result.`,
        input_schema: body.output_format.schema,
      }]
    : [];
  const requestTools = [...structuredDefinition, ...(body.tools ?? [])];
  const tools = anthropicTools(requestTools);
  const streaming = Boolean(body.on_text_delta) && !body.output_format && !body.tools?.length;
  // A model whose tool-call gateway corrupts forced arguments (see
  // structuredOutputToolStrategy) never gets the forced tool; the schema is
  // embedded in the system prompt instead, and the response is parsed from
  // prose (see the text fallback below).
  const effectiveSystem = structuredStrategy.schemaInstruction
    ? (body.system ? `${body.system}\n\n${structuredStrategy.schemaInstruction}` : structuredStrategy.schemaInstruction)
    : body.system;
  const system = effectiveSystem
    ? body.cache_strategy === "conversation"
      ? [{ type: "text", text: effectiveSystem, cache_control: { type: "ephemeral" } }]
      : effectiveSystem
    : undefined;
  const response = await fetchProviderResponse(networkProfile, anthropicMessagesUrl(provider), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system,
      messages: anthropicMessages(body),
      temperature: body.temperature,
      // Tool-use turns need headroom for the tool_use block plus a follow-up
      // answer, so default higher when tools are offered.
      max_tokens: effectiveMaxOutputTokens(model, body.max_tokens) ?? (tools ? 2048 : 1024),
      ...(tools ? {
        tools,
        tool_choice: structuredStrategy.forceTool
          ? { type: "tool", name: providerStructuredOutputName(body.output_format!.schema_id) }
          : { type: "auto" },
      } : {}),
      ...(streaming ? { stream: true } : {}),
    }),
    signal: body.abort_signal,
  });
  if (streaming) {
    return completeAnthropicStream(response, model, body.on_text_delta!);
  }
  const data = (await parseJsonResponse(response)) as {
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
    model?: string;
    usage?: Record<string, unknown>;
    stop_reason?: string | null;
  };
  const structuredSchemaId = body.output_format?.schema_id ?? null;
  const expectedToolName = structuredSchemaId ? providerStructuredOutputName(structuredSchemaId) : null;
  const structuredBlock = structuredSchemaId
    ? data.content?.find((block) => block.type === "tool_use" && block.name === expectedToolName)
      // Some Anthropic-compatible gateways preserve the tool call but rewrite
      // its name. Research runs have no runtime tools, so the only tool_use
      // block is unambiguously the structured result in that case.
      ?? (!body.tools?.length ? data.content?.find((block) => block.type === "tool_use") : undefined)
    : undefined;
  const textContent = data.content?.map((c) => c.text ?? "").join("") ?? "";
  // Unreliable models never get the forced tool (structuredStrategy.forceTool
  // is false), so they never produce a tool_use block; parse their answer
  // from prose instead, mirroring the OpenAI-compatible path's fallback.
  const structuredOutput = body.output_format
    ? structuredBlock && isStructuredObject(structuredBlock.input)
      ? structuredOutputFromValue(structuredBlock.input, body.output_format, {
          transport: "anthropic",
          finish_reason: data.stop_reason ?? "unknown",
          response_model: data.model ?? model,
          response_kind: "tool_use_input",
        })
      : structuredOutputFromText(textContent, body.output_format, {
          transport: "anthropic",
          finish_reason: data.stop_reason ?? "unknown",
          response_model: data.model ?? model,
          response_kind: "message_content",
        })
    : null;
  return {
    content: data.content?.map((c) => c.text ?? "").join("") ?? "",
    provider: "anthropic",
    model: data.model ?? model,
    usage: data.usage ?? {},
    tool_calls: anthropicToolCalls(data.content, body.tools),
    structured_output: structuredOutput,
    finish_reason: data.stop_reason ?? null,
  };
}

async function completeAnthropicStream(
  response: Response,
  requestedModel: string,
  onTextDelta: (delta: string) => void,
): Promise<ProviderChatResponseBody> {
  await assertStreamingResponseOk(response);
  let content = "";
  let model = requestedModel;
  let usage: Record<string, unknown> = {};
  let finishReason: string | null = null;
  let terminated = false;
  for await (const line of responseLines(response)) {
    if (!line.startsWith("data:")) continue;
    const event = jsonRecord(line.slice(5).trim());
    if (!event) continue;
    if (event.type === "message_stop") terminated = true;
    if (isRecord(event.message)) {
      model = stringField(event.message, "model") ?? model;
      if (isRecord(event.message.usage)) usage = { ...usage, ...event.message.usage };
    }
    if (isRecord(event.usage)) usage = { ...usage, ...event.usage };
    const deltaRecord = isRecord(event.delta) ? event.delta : null;
    const delta = deltaRecord?.type === "text_delta"
      ? stringField(deltaRecord, "text")
      : null;
    if (delta) {
      content += delta;
      onTextDelta(delta);
    }
    const stopReason = deltaRecord ? stringField(deltaRecord, "stop_reason") : null;
    if (stopReason) finishReason = stopReason;
  }
  if (!terminated) throw interruptedProviderStreamError();
  return {
    content,
    provider: "anthropic",
    model,
    usage,
    structured_output: null,
    finish_reason: finishReason,
  };
}

function isStructuredObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function completeOllama(
  provider: ProviderInfo,
  networkProfile: ResolvedNetworkProfile | null,
  body: ProviderChatRequestBody,
): Promise<ProviderChatResponseBody> {
  const base = provider.base_url?.replace(/\/+$/, "");
  if (!base) {
    throw new ProviderInvocationError(400, "base_url is required for provider_type 'ollama'");
  }
  const model = bareModelName("ollama", resolveModel(provider, body.model));
  const streaming = Boolean(body.on_text_delta) && !body.output_format && !body.tools?.length;
  const response = await fetchProviderResponse(networkProfile, `${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: streaming,
      messages: body.system
        ? [{ role: "system", content: body.system }, ...body.messages.map((m) => ({ role: m.role, content: m.content ?? "" }))]
        : body.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
      options: {
        temperature: body.temperature,
        num_predict: effectiveMaxOutputTokens(model, body.max_tokens) ?? undefined,
      },
      ...(body.output_format ? { format: body.output_format.schema } : {}),
    }),
    signal: body.abort_signal,
  });
  if (streaming) {
    return completeOllamaStream(response, model, body.on_text_delta!);
  }
  const data = (await parseJsonResponse(response)) as {
    message?: { content?: string };
    model?: string;
  };
  const content = data.message?.content ?? "";
  return {
    content,
    provider: "ollama",
    model: data.model ?? model,
    usage: {},
    structured_output: body.output_format
      ? structuredOutputFromText(content, body.output_format, {
          transport: "ollama",
          response_kind: "message_content",
          response_model: data.model ?? model,
        })
      : null,
  };
}

async function completeOllamaStream(
  response: Response,
  requestedModel: string,
  onTextDelta: (delta: string) => void,
): Promise<ProviderChatResponseBody> {
  await assertStreamingResponseOk(response);
  let content = "";
  let model = requestedModel;
  let finishReason: string | null = null;
  let usage: Record<string, unknown> = {};
  let terminated = false;
  for await (const line of responseLines(response)) {
    const event = jsonRecord(line.trim());
    if (!event) continue;
    model = stringField(event, "model") ?? model;
    const message = isRecord(event.message) ? event.message : null;
    const delta = message ? stringField(message, "content") : null;
    if (delta) {
      content += delta;
      onTextDelta(delta);
    }
    if (event.done === true) {
      terminated = true;
      finishReason = stringField(event, "done_reason") ?? "stop";
      usage = {
        prompt_tokens: event.prompt_eval_count,
        completion_tokens: event.eval_count,
      };
    }
  }
  if (!terminated) throw interruptedProviderStreamError();
  return {
    content,
    provider: "ollama",
    model,
    usage,
    structured_output: null,
    finish_reason: finishReason,
  };
}

function interruptedProviderStreamError(): ProviderInvocationError {
  return new ProviderInvocationError(
    502,
    "Provider stream ended before its terminal marker",
    { failure_class: "transient", actions: ["fallback_provider", "fail"] },
    "provider_stream_interrupted",
  );
}

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
  // A provider may be catalogued by vendor as Anthropic while exposing an
  // OpenAI-compatible endpoint (for example, a gateway or a multi-protocol
  // vendor). Managed API calls prefer that explicit OpenAI endpoint so JSON
  // Schema output uses one consistent transport. Native Anthropic is used
  // only when no OpenAI-compatible endpoint is configured.
  if (provider.provider_type === "anthropic" && provider.openai_compatible_base_url) {
    return completeOpenAiCompatible(provider, target.network_profile, apiKey, body);
  }
  if (provider.provider_type === "anthropic") {
    return completeAnthropic(provider, target.network_profile, apiKey, body);
  }
  if (provider.provider_type === "ollama") return completeOllama(provider, target.network_profile, body);
  return completeOpenAiCompatible(provider, target.network_profile, apiKey, body);
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
    metering?: ProviderMeteringContext | null;
    attribution: UsageAttribution;
  },
): Promise<void> {
  const context = input.metering ?? {};
  const provider = target.provider;
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
          metering: body.metering,
          attribution,
        });
        return result;
      } catch (error) {
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
): Promise<ProviderChatResponseBody> {
  assertMeteringContext(body.metering);
  const attribution = await resolveProviderUsageAttribution(
    store,
    spaceId,
    "llm.generation",
    body.metering,
  );
  const primary = await store.getInvocationTarget(spaceId, body.provider_id);
  if (body.output_format && !providerSupportsStructuredOutput(primary.provider.provider_type)) {
    throw structuredOutputUnsupportedError(primary.provider.provider_type);
  }
  const chain: InvocationTarget[] = [primary];
  for (const fallbackId of primary.fallback_provider_ids) {
    try {
      chain.push(await store.getInvocationTarget(spaceId, fallbackId));
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
        return await invokeProviderWithPool(store, target, effectiveBody, attribution);
      } catch (error) {
        // Weak instruction followers often fix their JSON when shown the
        // exact validation failure; one corrective round-trip is far cheaper
        // than failing the whole task.
        const corrective = structuredOutputCorrectionBody(effectiveBody, error);
        if (!corrective) throw error;
        return await invokeProviderWithPool(store, target, corrective, attribution);
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
    metering: meteringContext(input.metering, input.task),
  });

  // A structured contract is bound to the selected Research provider/model.
  // Auxiliary task policies may intentionally reroute generic work, but they
  // must not silently replace a Research execution contract.
  const taskChain = input.output_format || !input.task ? null : await store.getTaskChain(spaceId, input.task);
  let lastError: unknown = null;
  if (taskChain) {
    for (const entry of taskChain) {
      try {
        const result = await completeProviderChat(store, spaceId, chatBody(entry.provider_id, entry.model));
        return {
          text: result.content,
          provider: result.provider,
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
  const target = await store.getInvocationTarget(spaceId, providerId);
  const chain: InvocationTarget[] = [target];
  for (const fallbackId of target.fallback_provider_ids) {
    try {
      chain.push(await store.getInvocationTarget(spaceId, fallbackId));
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
          metering,
          attribution: requiredAttribution(attribution),
        });
        return result;
      } catch (error) {
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

  if (["openai", "openrouter", "other"].includes(provider.provider_type)) {
    if (!apiKey) {
      throw new ProviderInvocationError(400, `ModelProvider '${provider.id}' has no API key credential`);
    }
    const body: Record<string, unknown> = { model: resolvedModel, input: inputs };
    if (typeof dimensions === "number" && Number.isInteger(dimensions) && dimensions > 0) {
      body.dimensions = dimensions;
    }
    const response = await fetchProviderResponse(target.network_profile, `${openAiBase(provider)}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
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
  const target = await store.getInvocationTarget(spaceId, providerId);
  const chain: InvocationTarget[] = [target];
  for (const fallbackId of target.fallback_provider_ids) {
    try {
      chain.push(await store.getInvocationTarget(spaceId, fallbackId));
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
          metering,
          attribution: requiredAttribution(attribution),
        });
        return result;
      } catch (error) {
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
): Promise<{ models: string[]; source: "configured" | "live" }> {
  const configured = await store.listConfiguredModels(spaceId, providerId);
  if (configured.length > 0) return { models: configured, source: "configured" };
  const target = await store.getInvocationTarget(spaceId, providerId);
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
  if (["openai", "openrouter", "other"].includes(provider.provider_type)) {
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
