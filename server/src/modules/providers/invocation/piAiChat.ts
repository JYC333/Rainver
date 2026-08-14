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
import { classifyProviderFailure } from "./resilience";

type PiModule = typeof import("@earendil-works/pi-ai", { with: { "resolution-mode": "import" } });
type PiCatalogModule = typeof import("@earendil-works/pi-ai/providers/all", { with: { "resolution-mode": "import" } });

let piModulePromise: Promise<PiModule> | null = null;
let catalogModulePromise: Promise<PiCatalogModule> | null = null;

export interface ManagedOAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export type ManagedAuthPrompt = {
  signal?: AbortSignal;
  message: string;
  placeholder?: string;
} & (
  | { type: "text" | "secret" | "manual_code" }
  | { type: "select"; options: readonly { id: string; label: string; description?: string }[] }
);

export type ManagedAuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface ManagedAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: ManagedAuthPrompt): Promise<string>;
  notify(event: ManagedAuthEvent): void;
}

export interface ManagedOAuthFlow {
  login(interaction: ManagedAuthInteraction): Promise<ManagedOAuthCredential>;
  refresh(credential: ManagedOAuthCredential, signal: AbortSignal): Promise<ManagedOAuthCredential>;
}

/** Keep every pi-ai import and provider-auth implementation behind one adapter boundary. */
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

async function piModel(provider: ProviderInfo, modelId: string): Promise<Model<Api>> {
  const vendor = requireProviderVendor(provider.provider_type);
  const api = vendor.protocol === "anthropic_messages"
    ? "anthropic-messages"
    : vendor.protocol === "openai_codex_responses"
      ? "openai-codex-responses"
      : "openai-completions";
  let catalogModel: Model<Api> | undefined;
  if (vendor.piCatalog) {
    const { getBuiltinModels } = await loadPiCatalog();
    catalogModel = getBuiltinModels(vendor.piCatalog as Parameters<typeof getBuiltinModels>[0])
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
  return {
    ...(catalogModel ?? fallback),
    id: modelId,
    name: catalogModel?.name ?? modelId,
    api,
    provider: provider.provider_type,
    baseUrl: piBaseUrl(provider),
  } as Model<Api>;
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

export async function completePiAiChat(
  provider: ProviderInfo,
  networkFetch: typeof globalThis.fetch,
  apiKey: string | null,
  body: ProviderChatRequestBody,
): Promise<ProviderChatResponseBody> {
  if (!apiKey && provider.provider_type !== "ollama") {
    throw new ProviderInvocationError(400, `ModelProvider '${provider.id}' has no API key credential`);
  }
  const vendor = requireProviderVendor(provider.provider_type);
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
  const model = await piModel(provider, modelId);
  const outputTool = body.output_format && !body.tools?.length ? structuredTool(body.output_format) : null;
  const tools = outputTool ? [outputTool] : (body.tools ?? []).map(piTool);
  const context: Context = {
    systemPrompt: piSystemPrompt(body),
    messages: piMessages(body.messages),
    ...(tools.length ? { tools } : {}),
  };
  const api = await loadApi(vendor.protocol);
  const configuredMaxTokens = effectiveMaxOutputTokens(modelId, body.max_tokens);
  const maxTokens = configuredMaxTokens ??
    (vendor.protocol === "anthropic_messages" ? (tools.length ? 2_048 : 1_024) : undefined);
  let responseStatus: number | null = null;
  const trackedFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await networkFetch(input, {
      ...(init ?? {}),
      signal: init?.signal ?? body.abort_signal,
    });
    responseStatus = response.status;
    return response;
  };
  const stream = api.stream(model, context, {
    apiKey: apiKey ?? (provider.provider_type === "ollama" ? "ollama" : undefined),
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
    const status = responseStatus ?? (body.abort_signal?.aborted ? 499 : 502);
    throw new ProviderInvocationError(
      status === 499 ? 499 : 502,
      detail,
      status === 499
        ? { failure_class: "permanent", actions: ["fail"] }
        : responseStatus === null
          ? { failure_class: "transient", actions: ["fallback_provider", "fail"] }
          : classifyProviderFailure(responseStatus, detail),
      status === 499 ? "provider_request_aborted" : responseStatus === null ? "provider_network_error" : undefined,
    );
  }

  const providerSemanticStop = finalMessage.stopReason === "error" &&
    Boolean(finalMessage.rawStopReason) &&
    responseStatus !== null &&
    responseStatus >= 200 &&
    responseStatus < 300;
  if ((finalMessage.stopReason === "error" && !providerSemanticStop) || finalMessage.stopReason === "aborted") {
    const detail = finalMessage.errorMessage ?? "Provider request failed";
    const status = responseStatus ?? (finalMessage.stopReason === "aborted" ? 499 : 502);
    const decision = status === 499
      ? { failure_class: "permanent" as const, actions: ["fail" as const] }
      : responseStatus === null
        ? { failure_class: "transient" as const, actions: ["fallback_provider" as const, "fail" as const] }
        : classifyProviderFailure(status, detail);
    throw new ProviderInvocationError(
      status === 499 ? 499 : 502,
      detail,
      decision,
      status === 499
        ? "provider_request_aborted"
        : responseStatus === null
          ? "provider_network_error"
          : decision.failure_class === "rate_limit"
            ? "provider_rate_limit"
            : undefined,
    );
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
    tool_calls: responseToolCalls(finalMessage, body.tools),
    structured_output: structuredOutput,
    finish_reason: finishReason,
  };
}
