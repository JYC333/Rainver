import type {
  AssistantMessage,
  Api,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Context,
  Model,
  OAuthCredential,
  ProviderStreams,
  Tool,
} from "@earendil-works/pi-ai" with { "resolution-mode": "import" };
import type {
  CanonicalToolCall,
  CanonicalToolDefinition,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ProviderInfo } from "../commands/store";
import { effectiveMaxOutputTokens } from "../modelOutputLimits";
import { requireProviderVendor } from "../vendors";
import type {
  ChatMessage,
  ProviderChatRequestBody,
  ProviderChatResponseBody,
  ProviderStructuredOutput,
} from "./invocation";
import { ProviderInvocationError, structuredOutputFromText } from "./invocation";
import type { ManagedAuthEvent, ManagedAuthPrompt, ManagedOAuthFlow } from "../managedOAuth";
import { classifyProviderFailure, type ProviderResilienceDecision } from "./resilience";

type PiModule = typeof import("@earendil-works/pi-ai", { with: { "resolution-mode": "import" } });
type PiCatalogModule = typeof import("@earendil-works/pi-ai/providers/all", { with: { "resolution-mode": "import" } });

let piModulePromise: Promise<PiModule> | null = null;
let catalogModulePromise: Promise<PiCatalogModule> | null = null;

/**
 * Keep every pi-ai import and provider-auth implementation behind one adapter
 * boundary. The returned flow satisfies the agent-space `ManagedOAuthFlow`
 * contract; no caller sees a pi type.
 */
export async function loadManagedOAuthFlow(
  type: "anthropic" | "openai_codex",
): Promise<ManagedOAuthFlow> {
  const provider = type === "anthropic"
    ? (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider()
    : (await import("@earendil-works/pi-ai/providers/openai-codex")).openaiCodexProvider();
  if (!provider.auth.oauth) throw new Error(`Managed OAuth is unavailable for '${type}'`);
  return provider.auth.oauth as {
    login(interaction: AuthInteraction): Promise<OAuthCredential>;
    refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  } as ManagedOAuthFlow;
}

// Compile-time structural guards keep the local boundary contracts aligned
// with pi-ai without exporting pi types into provider ownership modules.
const _authPromptGuard: ManagedAuthPrompt extends AuthPrompt ? true : never = true;
const _authEventGuard: ManagedAuthEvent extends AuthEvent ? true : never = true;
void _authPromptGuard;
void _authEventGuard;

function loadPi(): Promise<PiModule> {
  piModulePromise ??= import("@earendil-works/pi-ai");
  return piModulePromise;
}

function loadPiCatalog(): Promise<PiCatalogModule> {
  catalogModulePromise ??= import("@earendil-works/pi-ai/providers/all");
  return catalogModulePromise;
}

async function loadApi(protocol: string): Promise<ProviderStreams> {
  if (protocol === "anthropic_messages") {
    const { anthropicMessagesApi } = await import("@earendil-works/pi-ai/api/anthropic-messages.lazy");
    return anthropicMessagesApi();
  }
  if (protocol === "openai_codex_responses") {
    const { openAICodexResponsesApi } = await import("@earendil-works/pi-ai/api/openai-codex-responses.lazy");
    return openAICodexResponsesApi();
  }
  const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
  return openAICompletionsApi();
}

function bareModelName(providerType: string, model: string): string {
  const prefixes = providerType === "anthropic" || providerType === "minimax"
    ? ["anthropic/", "minimax/"]
    : providerType === "openai_codex"
      ? ["openai-codex/", "openai_codex/"]
    : providerType === "openrouter"
      ? ["openrouter/"]
      : providerType === "ollama"
        ? ["ollama/"]
        : ["openai/"];
  return prefixes.find((prefix) => model.startsWith(prefix))
    ? model.slice(prefixes.find((prefix) => model.startsWith(prefix))!.length)
    : model;
}

function defaultModel(providerType: string): string {
  if (providerType === "openai_codex") return "gpt-5.6-sol";
  if (providerType === "anthropic") return "claude-3-5-sonnet-latest";
  if (providerType === "minimax") return "MiniMax-M3";
  if (providerType === "openrouter") return "openai/gpt-4o-mini";
  if (providerType === "deepseek") return "deepseek-v4-flash";
  if (providerType === "ollama") return "llama3";
  return "gpt-4o-mini";
}

function resolveModelName(provider: ProviderInfo, requested?: string | null): string {
  return bareModelName(
    provider.provider_type,
    requested ?? provider.default_model ?? provider.available_models[0] ?? defaultModel(provider.provider_type),
  );
}

function piBaseUrl(provider: ProviderInfo): string {
  let base = (provider.base_url ?? "").replace(/\/+$/, "");
  if (requireProviderVendor(provider.provider_type).protocol === "anthropic_messages" && base.endsWith("/v1")) {
    base = base.slice(0, -3);
  }
  if (provider.provider_type === "ollama" && !base.endsWith("/v1")) return `${base}/v1`;
  return base;
}

/**
 * Which pi-ai catalog describes a vendor's models, when one does.
 *
 * This is a fact about pi-ai, not about the vendor, so it lives with the
 * adapter rather than in the server's vendor registry.
 *
 * A vendor absent from this map has no per-model rates available here, and a
 * call to it is therefore recorded as having no known price rather than as
 * costing nothing. Three kinds of vendor are absent deliberately: the embedding
 * and rerank vendors, which pi-ai does not cover at all; custom endpoints,
 * whose models are whatever the operator points them at; and Ollama, whose
 * models are locally served and genuinely unpriced. Ollama's marginal cost to
 * the operator may well be zero, but that is a funding fact the router owns,
 * not something this ledger can observe — from here it is a gap.
 */
const PI_CATALOG_BY_VENDOR: Readonly<Partial<Record<string, string>>> = {
  openai: "openai",
  openai_codex: "openai-codex",
  anthropic: "anthropic",
  minimax: "minimax",
  openrouter: "openrouter",
  deepseek: "deepseek",
};

/** Exposed so a test can assert the map still covers every vendor whose models pi-ai describes. */
export function piCatalogForVendor(vendorId: string): string | null {
  return PI_CATALOG_BY_VENDOR[vendorId] ?? null;
}

/** Exposed so a test can catch a key that names no vendor. */
export function piCatalogVendorIds(): readonly string[] {
  return Object.keys(PI_CATALOG_BY_VENDOR);
}

async function piModel(
  provider: ProviderInfo,
  modelId: string,
): Promise<{ model: Model<Api>; costAccuracy: "catalog" | "unknown" }> {
  const vendor = requireProviderVendor(provider.provider_type);
  const piCatalog = piCatalogForVendor(vendor.id);
  const api = vendor.protocol === "anthropic_messages"
    ? "anthropic-messages"
    : vendor.protocol === "openai_codex_responses"
      ? "openai-codex-responses"
      : "openai-completions";
  let catalogModel: Model<Api> | undefined;
  if (piCatalog) {
    const { getBuiltinModels } = await loadPiCatalog();
    catalogModel = getBuiltinModels(piCatalog as Parameters<typeof getBuiltinModels>[0])
      .find((candidate) => candidate.id === modelId) as Model<Api> | undefined;
  }
  const fallback: Model<Api> = {
    id: modelId,
    name: modelId,
    api,
    provider: provider.provider_type,
    baseUrl: piBaseUrl(provider),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...(api === "openai-completions" &&
    (provider.provider_type === "openai_compatible" || provider.provider_type === "ollama")
      ? {
          // Custom and older OpenAI-compatible servers commonly implement the
          // original Chat Completions fields only. Preserve the request shape
          // agent-space used before Pi instead of auto-detecting modern OpenAI
          // features from an arbitrary URL.
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens" as const,
          },
        }
      : {}),
  };
  return { model: {
    ...(catalogModel ?? fallback),
    id: modelId,
    name: catalogModel?.name ?? modelId,
    api,
    provider: provider.provider_type,
    baseUrl: piBaseUrl(provider),
  } as Model<Api>, costAccuracy: catalogModel ? "catalog" : "unknown" };
}

function toolCall(call: CanonicalToolCall) {
  let argumentsValue: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.arguments_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      argumentsValue = parsed as Record<string, unknown>;
    }
  } catch {
    // Canonical tool arguments are validated before dispatch. Preserve an
    // invalid historical value as an empty object so pi can still serialize
    // the conversation and the runtime tool boundary remains authoritative.
  }
  return { type: "toolCall" as const, id: call.id, name: providerToolName(call.name), arguments: argumentsValue };
}

function piMessages(messages: ChatMessage[]): Context["messages"] {
  const now = Date.now();
  return messages.flatMap((message, index): Context["messages"] => {
    const timestamp = now + index;
    if (message.role === "system") return [];
    if (message.role === "tool" && message.tool_call_id) {
      return [{
        role: "toolResult",
        toolCallId: message.tool_call_id,
        toolName: providerToolName(message.name ?? "tool"),
        content: [{ type: "text", text: message.content ?? "" }],
        isError: false,
        timestamp,
      }];
    }
    if (message.role === "assistant") {
      return [{
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...(message.tool_calls ?? []).map(toolCall),
        ],
        api: "pi-messages",
        provider: "agent-space",
        model: "transcript",
        usage: emptyUsage(),
        stopReason: message.tool_calls?.length ? "toolUse" : "stop",
        timestamp,
      }];
    }
    return [{ role: "user", content: message.content ?? "", timestamp }];
  });
}

function piSystemPrompt(body: ProviderChatRequestBody): string | undefined {
  const parts = [
    body.system,
    ...body.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content),
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length ? parts.join("\n\n") : undefined;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function piTool(definition: CanonicalToolDefinition): Tool {
  return {
    name: providerToolName(definition.name),
    description: definition.description ?? "",
    parameters: (definition.input_schema ?? { type: "object", properties: {} }) as Tool["parameters"],
  };
}

function providerToolName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return safe || "tool";
}

function toolNameReverseMap(tools: CanonicalToolDefinition[] | null | undefined): Map<string, string> {
  return new Map((tools ?? []).map((tool) => [providerToolName(tool.name), tool.name]));
}

function structuredTool(output: ProviderStructuredOutput): Tool {
  return {
    name: output.schema_id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "structured_output",
    description: `Return the ${output.schema_id} structured result.`,
    parameters: output.schema as Tool["parameters"],
    // `strict` remains an output-validation contract at agent-space's
    // boundary. Provider-side strict tools are best-effort so vendors without
    // that capability can still reach the text scavenger and be validated.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  };
}

export function piStructuredToolChoice(protocol: string, toolName: string) {
  if (protocol === "anthropic_messages") {
    return { type: "tool" as const, name: toolName };
  }
  if (protocol === "openai_codex_responses") return "required" as const;
  return { type: "function" as const, function: { name: toolName } };
}

function responseUsage(message: AssistantMessage): Record<string, unknown> {
  const reported = message.usage.input > 0 ||
    message.usage.output > 0 ||
    message.usage.cacheRead > 0 ||
    message.usage.cacheWrite > 0 ||
    (message.usage.cacheWrite1h ?? 0) > 0 ||
    message.usage.totalTokens > 0 ||
    message.usage.reasoning !== undefined;
  if (!reported) return {};
  return {
    input_tokens: message.usage.input,
    // pi-ai documents reasoning as a subset of output. The agent-space
    // ledger stores disjoint buckets so totals remain recomputable.
    output_tokens: Math.max(0, message.usage.output - (message.usage.reasoning ?? 0)),
    total_tokens: message.usage.totalTokens,
    cache_read_input_tokens: message.usage.cacheRead,
    cache_creation_input_tokens: message.usage.cacheWrite,
    cache_creation_1h_input_tokens: message.usage.cacheWrite1h,
    reasoning_tokens: message.usage.reasoning,
  };
}

function responseCost(message: AssistantMessage) {
  return {
    input: roundCost(message.usage.cost.input),
    output: roundCost(message.usage.cost.output),
    cacheRead: roundCost(message.usage.cost.cacheRead),
    cacheWrite: roundCost(message.usage.cost.cacheWrite),
    total: roundCost(message.usage.cost.total),
  };
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

function responseText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function providerFinishReason(protocol: string, message: AssistantMessage): string {
  if (message.rawStopReason) return message.rawStopReason;
  const stopReason = message.stopReason;
  if (protocol === "anthropic_messages") {
    if (stopReason === "toolUse") return "tool_use";
    if (stopReason === "length") return "max_tokens";
    if (stopReason === "stop") return "end_turn";
  }
  if (stopReason === "toolUse") return "tool_calls";
  if (stopReason === "length") return "length";
  return stopReason;
}

function responseToolCalls(message: AssistantMessage, allowed: CanonicalToolDefinition[] | null | undefined): CanonicalToolCall[] | undefined {
  const reverseNames = toolNameReverseMap(allowed);
  const calls = message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "toolCall" }> => part.type === "toolCall")
    .filter((part) => Boolean(part.id && part.name))
    .map((part) => ({
      id: part.id,
      name: reverseNames.get(part.name) ?? part.name,
      arguments_json: JSON.stringify(part.arguments),
    }));
  return calls.length ? calls : undefined;
}

/**
 * How a stream that failed part-way through should be classified.
 *
 * The status line is only a verdict when the provider actually reached one.
 * Once 2xx headers have arrived, the response is committed and a failure while
 * reading the body is the transport dropping it — undici surfaces exactly that
 * as a bare `terminated`. Classifying it from the 200 already in hand filed it
 * as `permanent`, which fails immediately with no same-key retry and no
 * provider fallback; the longest single generation on the platform (a whole
 * research report in one structured response) therefore died for good every
 * time its socket was cut.
 *
 * It is deliberately not `provider_network_error`: that code carries the
 * larger retry budget meant for failures that cost nothing because no response
 * ever started. A stream that died mid-body has already been paid for in full,
 * so it takes the ordinary transient budget of one same-key retry before
 * falling back.
 *
 * A non-2xx status is a real provider verdict streamed as an error body and
 * keeps its own taxonomy; an aborted request is the run owner's decision and
 * is never retried.
 */
function streamFailure(
  responseStatus: number | null,
  detail: string,
  aborted: boolean,
): { status: number; decision: ProviderResilienceDecision; code?: string } {
  if (aborted) {
    return {
      status: 499,
      decision: { failure_class: "permanent", actions: ["fail"] },
      code: "provider_request_aborted",
    };
  }
  if (responseStatus === null) {
    return {
      status: 502,
      decision: { failure_class: "transient", actions: ["fallback_provider", "fail"] },
      code: "provider_network_error",
    };
  }
  if (responseStatus >= 200 && responseStatus < 300) {
    return {
      status: 502,
      decision: { failure_class: "transient", actions: ["fallback_provider", "fail"] },
      code: "provider_stream_terminated",
    };
  }
  const decision = classifyProviderFailure(responseStatus, detail);
  return {
    status: 502,
    decision,
    code: decision.failure_class === "rate_limit" ? "provider_rate_limit" : undefined,
  };
}

export async function completePiAiChat(
  provider: ProviderInfo,
  networkFetch: typeof globalThis.fetch,
  apiKey: string | null,
  body: ProviderChatRequestBody,
): Promise<ProviderChatResponseBody> {
  const vendor = requireProviderVendor(provider.provider_type);
  if (!apiKey && vendor.apiKeyRequired) {
    throw new ProviderInvocationError(400, `ModelProvider '${provider.id}' has no API key credential`);
  }
  if (!vendor.supportsChat) {
    throw new ProviderInvocationError(400, `provider_type '${provider.provider_type}' does not support chat`);
  }
  if (body.tools?.length && !vendor.supportsRuntimeTools) {
    throw new ProviderInvocationError(
      400,
      `provider_type '${provider.provider_type}' does not support runtime-host tools yet`,
      { failure_class: "permanent", actions: ["fail"] },
      "runtime_tool_provider_unsupported",
    );
  }

  await loadPi();
  const modelId = resolveModelName(provider, body.model);
  const { model, costAccuracy } = await piModel(provider, modelId);
  const outputTool = body.output_format && !body.tools?.length ? structuredTool(body.output_format) : null;
  const tools = outputTool ? [outputTool] : (body.tools ?? []).map(piTool);
  const context: Context = {
    systemPrompt: piSystemPrompt(body),
    messages: piMessages(body.messages),
    ...(tools.length ? { tools } : {}),
  };
  const api = await loadApi(vendor.protocol);
  const maxTokens = effectiveMaxOutputTokens(modelId, body.max_tokens) ?? undefined;
  let responseStatus: number | null = null;
  const trackedFetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (!apiKey) headers.delete("authorization");
    const response = await networkFetch(input, {
      ...(init ?? {}),
      headers,
      signal: init?.signal ?? body.abort_signal,
    });
    responseStatus = response.status;
    return response;
  };
  const stream = api.stream(model, context, {
    // pi-ai requires a non-empty option before constructing an OpenAI stream,
    // even for registries that explicitly allow keyless endpoints. The value
    // never crosses the adapter boundary: trackedFetch strips Authorization
    // whenever agent-space supplied no credential.
    apiKey: apiKey ?? "agent-space-keyless",
    fetch: trackedFetch,
    signal: body.abort_signal,
    temperature: body.temperature,
    maxTokens,
    cacheRetention: body.cache_strategy === "conversation" ? "short" : "none",
    maxRetries: 0,
    headers: { "accept-encoding": "identity" },
    ...(vendor.protocol === "openai_codex_responses" ? { transport: "sse" as const } : {}),
    onResponse(response) {
      responseStatus = response.status;
    },
    ...(outputTool ? { toolChoice: piStructuredToolChoice(vendor.protocol, outputTool.name) } : {}),
  });

  let finalMessage: AssistantMessage | null = null;
  try {
    for await (const event of stream) {
      if (event.type === "text_delta" && !body.output_format && !body.tools?.length) {
        body.on_text_delta?.(event.delta);
      }
      if (event.type === "done") finalMessage = event.message;
      if (event.type === "error") finalMessage = event.error;
    }
    finalMessage ??= await stream.result();
  } catch (error) {
    if (error instanceof ProviderInvocationError) throw error;
    const detail = error instanceof Error ? error.message : "Provider request failed";
    const failure = streamFailure(responseStatus, detail, body.abort_signal?.aborted === true);
    throw new ProviderInvocationError(failure.status, detail, failure.decision, failure.code);
  }

  const providerSemanticStop = finalMessage.stopReason === "error" &&
    Boolean(finalMessage.rawStopReason) &&
    responseStatus !== null &&
    responseStatus >= 200 &&
    responseStatus < 300;
  if ((finalMessage.stopReason === "error" && !providerSemanticStop) || finalMessage.stopReason === "aborted") {
    const detail = finalMessage.errorMessage ?? "Provider request failed";
    const failure = streamFailure(
      responseStatus,
      detail,
      finalMessage.stopReason === "aborted" || body.abort_signal?.aborted === true,
    );
    throw new ProviderInvocationError(failure.status, detail, failure.decision, failure.code);
  }

  const text = responseText(finalMessage);
  const finishReason = providerFinishReason(vendor.protocol, finalMessage);
  const structuredCall = outputTool
    ? finalMessage.content.find((part) => part.type === "toolCall" && part.name === outputTool.name)
      ?? finalMessage.content.find((part) => part.type === "toolCall")
    : null;
  let structuredOutput: Record<string, unknown> | null = null;
  if (body.output_format) {
    try {
      structuredOutput = structuredCall?.type === "toolCall"
        ? structuredOutputFromText(JSON.stringify(structuredCall.arguments), body.output_format, {
            transport: vendor.protocol,
            response_kind: "tool_call_arguments",
            response_model: finalMessage.responseModel ?? finalMessage.model,
          })
        : structuredOutputFromText(text, body.output_format, {
            transport: vendor.protocol,
            response_kind: "message_content",
            response_model: finalMessage.responseModel ?? finalMessage.model,
            finish_reason: finishReason,
          });
    } catch (error) {
      if (error instanceof ProviderInvocationError && error.code === "structured_output_invalid") {
        throw new ProviderInvocationError(
          error.statusCode,
          error.message,
          error.resilience,
          error.code,
          error.diagnostics,
          [text, structuredCall?.type === "toolCall" ? JSON.stringify(structuredCall.arguments) : null]
            .filter(Boolean)
            .join("\n"),
        );
      }
      throw error;
    }
  }

  return {
    content: text,
    provider: provider.provider_type,
    model: finalMessage.responseModel ?? finalMessage.model,
    usage: responseUsage(finalMessage),
    cost: responseCost(finalMessage),
    cost_accuracy: costAccuracy,
    tool_calls: responseToolCalls(finalMessage, body.tools),
    structured_output: structuredOutput,
    finish_reason: finishReason,
  };
}
