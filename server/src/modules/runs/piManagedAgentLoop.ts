/**
 * `ManagedAgentLoopPort` implemented over @earendil-works/pi-agent-core.
 *
 * This is the only module in the server allowed to reach that package, which
 * `boundaries.test.ts` enforces. Pi owns transcript accumulation, sequential
 * batch execution, truncated-batch failure and turn stopping. It owns nothing
 * else: every model turn goes back out through the agent-space executor, and
 * every tool call goes back out through the caller's dispatch into
 * `SystemActionGateway`.
 *
 * pi-agent-core is loaded through the dynamic `import()` below on purpose:
 * it is a large package that only managed-agent runs need, so it is not paid
 * for by every process that imports this module.
 */
import type {
  CanonicalMessage,
  CanonicalToolCall,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@agent-space/protocol";
import type {
  ManagedAgentLoopInput,
  ManagedAgentLoopPort,
  ManagedAgentLoopResult,
} from "./managedAgentLoopPort.js";

type PiCoreModule = typeof import("@earendil-works/pi-agent-core");
type PiAgentMessage = import("@earendil-works/pi-agent-core").AgentMessage;
type PiAssistantMessage = Extract<PiAgentMessage, { role: "assistant" }>;
type PiModel = import("@earendil-works/pi-agent-core").AgentState["model"];

let piCorePromise: Promise<PiCoreModule> | null = null;

function loadPiCore(): Promise<PiCoreModule> {
  piCorePromise ??= import("@earendil-works/pi-agent-core");
  return piCorePromise;
}

/**
 * The loop holds substantial state for the duration of one call — the raw tool
 * arguments map, accumulated summaries, the turn counter, and pi's own `Agent`
 * with its transient transcript — and none of it survives the returned promise.
 * Nothing is held across calls, so the port is satisfied by a plain object
 * rather than an instantiated class.
 */
async function runManagedAgentLoop(input: ManagedAgentLoopInput): Promise<ManagedAgentLoopResult> {
  const { Agent } = await loadPiCore();
  const toolSummaries: Array<Record<string, unknown>> = [];
  const artifacts: unknown[] = [];
  const rawCalls = new Map<string, CanonicalToolCall>();
  let suspendResponse: RuntimeHostExecuteResponse | null = null;
  let lastResponse: RuntimeHostExecuteResponse | null = null;
  let modelTurns = 0;
  let turnLimitReached = false;
  const installedToolNames = new Set(input.tools.map((tool) => tool.name));

  const executeTool = async (toolName: string, toolCallId: string, params: unknown) => {
    const call = rawCalls.get(toolCallId) ?? {
      id: toolCallId,
      name: toolName,
      arguments_json: JSON.stringify(params ?? {}),
    };
    const result = await input.dispatch(call);
    toolSummaries.push(result.summary);
    if (result.artifact) artifacts.push(result.artifact);
    if (result.suspend) suspendResponse = result.suspend;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.modelResult) }],
      details: result.summary,
      ...(result.suspend ? { terminate: true } : {}),
    };
  };
  const agentTool = (name: string, description = "") => ({
    name,
    label: name,
    description,
    // The canonical SystemActionGateway remains the validation authority. Pi's
    // internal schema is deliberately permissive so invalid or ungranted model
    // calls still reach that gateway and receive the existing structured,
    // audited denial rather than a vendor-loop error string.
    parameters: { type: "object", additionalProperties: true } as never,
    executionMode: "sequential" as const,
    execute: (toolCallId: string, params: unknown) => executeTool(name, toolCallId, params),
  });

  const initialMessages = canonicalToPiMessages(
    input.request.messages?.length
      ? input.request.messages
      : [{ role: "user", content: input.request.prompt }],
  );
  const model = loopModel(input.request);
  const agent = new Agent({
    initialState: {
      systemPrompt: input.request.system_prompt ?? "",
      model,
      messages: initialMessages,
      tools: input.tools.map((definition) => agentTool(definition.name, definition.description ?? "")),
    },
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      // `streamFn` records the canonical call before pi parses its arguments.
      // Keep that original JSON whenever it exists; pi intentionally receives
      // a permissive object schema, but SystemActionGateway must validate the
      // exact bytes supplied by the provider (including malformed JSON).
      if (!rawCalls.has(toolCall.id)) {
        rawCalls.set(toolCall.id, {
          id: toolCall.id,
          name: toolCall.name,
          arguments_json: JSON.stringify(toolCall.arguments ?? {}),
        });
      }
      if (suspendResponse) {
        return {
          block: true,
          reason: "The managed run is suspended; later calls in this batch were not executed.",
          terminate: true,
        };
      }
      return undefined;
    },
    shouldStopAfterTurn: async ({ message, toolResults, context, newMessages }) => {
      if (suspendResponse) return true;
      if (input.signal?.aborted) {
        padAbortedToolBatch(message, toolResults, context.messages, newMessages);
        return true;
      }
      if (modelTurns >= input.maxTurns) {
        turnLimitReached = true;
        return true;
      }
      return false;
    },
    streamFn: async (_activeModel, context) => {
      modelTurns += 1;
      const canonicalMessages = piToCanonicalMessages(context.messages, rawCalls);
      let response = await input.executeModel(input.config, {
        ...input.request,
        messages: canonicalMessages,
        tool_mode: "authorized_bindings",
        tool_bindings: input.toolBindings,
        tools: input.tools,
      });
      if (
        modelTurns === 1 &&
        !response.success &&
        response.error_code === "runtime_tool_provider_unsupported"
      ) {
        response = await input.executeModel(input.config, {
          ...input.request,
          messages: canonicalMessages,
          tool_mode: "disabled",
          tool_bindings: [],
          tools: [],
        });
        // The fallback belongs here: the effective provider is only known
        // inside the executor, because a Delivery may remap the provider id.
        // The summary must not name a tool family — every family is affected
        // when the provider cannot take tools at all.
        toolSummaries.push({
          tool_name: "managed_tools",
          ok: false,
          error_code: "managed_tool_provider_unsupported",
        });
      }
      lastResponse = response;
      const responseCalls = toolCallsFromResponse(response);
      for (const call of responseCalls) rawCalls.set(call.id, call);
      const missingTools = responseCalls
        .map((call) => call.name)
        .filter((name) => !installedToolNames.has(name));
      if (missingTools.length) {
        for (const name of missingTools) installedToolNames.add(name);
        const fallbacks = missingTools.map((name) => agentTool(name));
        // `context` is the current loop snapshot; updating Agent state alone
        // would only affect a later run, after this batch has already failed.
        context.tools?.push(...fallbacks);
        agent.state.tools = [...agent.state.tools, ...fallbacks];
      }
      return responseStream(response, input.signal) as never;
    },
  });

  const abort = () => agent.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  // `Agent.abort()` needs an active run. Defer an already-aborted signal until
  // `continue()` has synchronously installed that run lifecycle.
  if (input.signal?.aborted) queueMicrotask(abort);
  try {
    const last = initialMessages.at(-1);
    if (last?.role === "user" || last?.role === "toolResult") {
      await agent.continue();
    } else {
      await agent.prompt(input.request.prompt);
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }

  // TypeScript cannot observe assignments made from pi's stream callback.
  const completedResponse = lastResponse as RuntimeHostExecuteResponse | null;
  const response = suspendResponse ?? (
    input.signal?.aborted && completedResponse?.success
      ? abortedLoopResponse(input.request, completedResponse)
      : completedResponse
  );
  if (!response) {
    throw new Error("The managed agent loop completed without a Runtime Host response.");
  }
  return { response, toolSummaries, artifacts, turnLimitReached };
}

function loopModel(request: RuntimeHostExecuteRequest): PiModel {
  const id = request.model ?? "provider-default";
  return {
    id,
    name: id,
    api: "pi-messages",
    provider: "agent-space",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: request.max_tokens ?? 16_384,
  };
}

function canonicalToPiMessages(messages: readonly CanonicalMessage[]): PiAgentMessage[] {
  const now = Date.now();
  return messages.flatMap((message, index): PiAgentMessage[] => {
    const timestamp = now + index;
    if (message.role === "tool" && message.tool_call_id) {
      return [{
        role: "toolResult",
        toolCallId: message.tool_call_id,
        toolName: message.name ?? "tool",
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
          ...(message.tool_calls ?? []).map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: parseArguments(call.arguments_json),
          })),
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

function piToCanonicalMessages(
  messages: readonly PiAgentMessage[],
  rawCalls: ReadonlyMap<string, CanonicalToolCall>,
): CanonicalMessage[] {
  return messages.flatMap((message): CanonicalMessage[] => {
    if (message.role === "user") {
      return [{ role: "user", content: contentText(message.content) }];
    }
    if (message.role === "toolResult") {
      return [{
        role: "tool",
        content: contentText(message.content),
        tool_call_id: message.toolCallId,
        name: message.toolName,
      }];
    }
    if (message.role === "assistant") {
      const calls = message.content
        .filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall")
        .map((call) => ({
          id: call.id,
          name: call.name,
          arguments_json: rawCalls.get(call.id)?.arguments_json
            ?? JSON.stringify(call.arguments ?? {}),
        }));
      return [{
        role: "assistant",
        content: message.content
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("") || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      }];
    }
    return [];
  });
}

function responseStream(response: RuntimeHostExecuteResponse, signal?: AbortSignal) {
  const stream = new CompletedAssistantStream();
  const calls = toolCallsFromResponse(response);
  const text = response.output_text || response.stdout || "";
  const stopReason = responseStopReason(response, calls.length > 0, signal);
  const message: PiAssistantMessage = {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: parseArguments(call.arguments_json),
      })),
    ],
    api: "pi-messages",
    provider: "agent-space",
    model: response.model ?? "provider-default",
    usage: usageFromResponse(response),
    stopReason,
    ...(response.error_text ? { errorMessage: response.error_text } : {}),
    timestamp: Date.now(),
  };
  const partial: PiAssistantMessage = { ...message, content: [], stopReason: "pending" };
  stream.push({ type: "start", partial });
  let contentIndex = 0;
  if (text) {
    const textPartial = { ...partial, content: [{ type: "text" as const, text: "" }] };
    stream.push({ type: "text_start", contentIndex, partial: textPartial });
    stream.push({ type: "text_delta", contentIndex, delta: text, partial: { ...textPartial, content: [{ type: "text", text }] } });
    stream.push({ type: "text_end", contentIndex, content: text, partial: { ...textPartial, content: [{ type: "text", text }] } });
    contentIndex += 1;
  }
  for (const call of calls) {
    const before = { ...partial, content: message.content.slice(0, contentIndex) };
    stream.push({ type: "toolcall_start", contentIndex, partial: before });
    stream.push({ type: "toolcall_delta", contentIndex, delta: call.arguments_json, partial: before });
    stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall: message.content[contentIndex] as Extract<PiAssistantMessage["content"][number], { type: "toolCall" }>,
      partial: { ...partial, content: message.content.slice(0, contentIndex + 1) },
    });
    contentIndex += 1;
  }
  if (stopReason === "error" || stopReason === "aborted") {
    stream.push({ type: "error", reason: stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: stopReason, message });
  }
  stream.end(message);
  return stream;
}

class CompletedAssistantStream implements AsyncIterable<unknown> {
  private readonly events: unknown[] = [];
  private finalMessage: PiAssistantMessage | null = null;

  push(event: unknown): void {
    this.events.push(event);
  }

  end(message: PiAssistantMessage): void {
    this.finalMessage = message;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (const event of this.events) yield event;
  }

  async result(): Promise<PiAssistantMessage> {
    if (!this.finalMessage) throw new Error("Assistant stream ended without a message.");
    return this.finalMessage;
  }
}

function responseStopReason(
  response: RuntimeHostExecuteResponse,
  hasToolCalls: boolean,
  signal?: AbortSignal,
): PiAssistantMessage["stopReason"] {
  if (!response.success) return signal?.aborted ? "aborted" : "error";
  const stop = [...response.events].reverse().find((event) => event.type === "model.message_stop");
  if (
    stop?.type === "model.message_stop"
    && (stop.finish_reason === "length" || stop.finish_reason === "max_tokens")
  ) return "length";
  return hasToolCalls ? "toolUse" : "stop";
}

function usageFromResponse(response: RuntimeHostExecuteResponse) {
  const usage = response.usage;
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    ...(usage?.cache_creation_1h_input_tokens !== undefined
      ? { cacheWrite1h: usage.cache_creation_1h_input_tokens }
      : {}),
    totalTokens: usage?.total_tokens ?? 0,
    ...(usage?.reasoning_tokens !== undefined ? { reasoning: usage.reasoning_tokens } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
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

function toolCallsFromResponse(response: RuntimeHostExecuteResponse): CanonicalToolCall[] {
  const output = recordOrEmpty(response.output_json);
  const calls = Array.isArray(output.tool_calls) ? output.tool_calls : [];
  return calls.filter((call): call is CanonicalToolCall => {
    const value = recordOrEmpty(call);
    return typeof value.id === "string" &&
      typeof value.name === "string" &&
      typeof value.arguments_json === "string";
  });
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function padAbortedToolBatch(
  assistant: PiAssistantMessage,
  toolResults: Extract<PiAgentMessage, { role: "toolResult" }>[],
  contextMessages: PiAgentMessage[],
  newMessages: PiAgentMessage[],
): void {
  const completed = new Set(toolResults.map((result) => result.toolCallId));
  for (const call of assistant.content) {
    if (call.type !== "toolCall" || completed.has(call.id)) continue;
    const result: Extract<PiAgentMessage, { role: "toolResult" }> = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: JSON.stringify({
        ok: false,
        error_code: "provider_request_aborted",
        error: "The managed run was cancelled before this tool call executed.",
      }) }],
      details: { error_code: "provider_request_aborted" },
      isError: true,
      timestamp: Date.now(),
    };
    toolResults.push(result);
    contextMessages.push(result);
    newMessages.push(result);
  }
}

function abortedLoopResponse(
  request: RuntimeHostExecuteRequest,
  previous: RuntimeHostExecuteResponse,
): RuntimeHostExecuteResponse {
  const errorText = "Provider request was aborted.";
  return {
    ...previous,
    success: false,
    stdout: "",
    stderr: errorText,
    output_text: "",
    output_json: {
      adapter_type: "ts_agent_host",
      run_id: request.run_id,
      model_provider_id: request.model_provider_id,
      model: request.model ?? null,
    },
    exit_code: 1,
    error_code: "provider_request_aborted",
    error_text: errorText,
    completed_at: new Date().toISOString(),
    events: [{
      type: "model.error",
      error: { code: "provider_request_aborted", message: errorText },
    }],
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part) && typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("");
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export const piManagedAgentLoop: ManagedAgentLoopPort = { run: runManagedAgentLoop };
