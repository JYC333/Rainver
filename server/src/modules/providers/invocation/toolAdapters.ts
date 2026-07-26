import type {
  CanonicalToolCall,
  CanonicalToolDefinition,
} from "@agent-space/protocol" with { "resolution-mode": "import" };

interface ToolChatMessage {
  role: string;
  content: string | null;
  tool_calls?: CanonicalToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolChatBody {
  messages: ToolChatMessage[];
  system?: string | null;
  tools?: CanonicalToolDefinition[] | null;
  cache_strategy?: "conversation";
}

function providerToolName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return safe || "tool";
}

function toolNameMap(tools: CanonicalToolDefinition[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools ?? []) map.set(tool.name, providerToolName(tool.name));
  return map;
}

function toolReverseMap(tools: CanonicalToolDefinition[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools ?? []) map.set(providerToolName(tool.name), tool.name);
  return map;
}

function inputFromArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function jsonArguments(value: unknown): string {
  if (value === undefined) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

export function openAiMessages(body: ToolChatBody): Array<Record<string, unknown>> {
  const names = toolNameMap(body.tools);
  const messages = body.messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content ?? "",
        tool_call_id: message.tool_call_id,
      };
    }
    const mapped: Record<string, unknown> = {
      role: message.role,
      content: message.content ?? "",
    };
    if (message.tool_calls?.length) {
      mapped.content = message.content;
      mapped.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: names.get(call.name) ?? providerToolName(call.name),
          arguments: call.arguments_json,
        },
      }));
    }
    return mapped;
  });
  return body.system
    ? [{ role: "system", content: body.system }, ...messages]
    : messages;
}

export function openAiTools(
  tools: CanonicalToolDefinition[] | null | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  const names = toolNameMap(tools);
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: names.get(tool.name) ?? providerToolName(tool.name),
      description: tool.description,
      parameters: tool.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

export function openAiToolCalls(
  calls: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }> | null | undefined,
  tools: CanonicalToolDefinition[] | null | undefined,
): CanonicalToolCall[] {
  const reverseNames = toolReverseMap(tools);
  const toolCalls: CanonicalToolCall[] = [];
  for (const call of calls ?? []) {
    const rawName = call.function?.name ?? "";
    const name = reverseNames.get(rawName) ?? rawName;
    if (!call.id || !name) continue;
    toolCalls.push({
      id: call.id,
      name,
      arguments_json: call.function?.arguments ?? "{}",
    });
  }
  return toolCalls;
}

export function anthropicMessages(body: ToolChatBody): Array<Record<string, unknown>> {
  const names = toolNameMap(body.tools);
  const messages: Array<Record<string, unknown>> = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of body.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      if (message.tool_call_id) {
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: message.content ?? "",
        });
      }
      continue;
    }

    flushToolResults();
    if (message.role === "assistant" && message.tool_calls?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: names.get(call.name) ?? providerToolName(call.name),
          input: inputFromArguments(call.arguments_json),
        });
      }
      messages.push({ role: "assistant", content });
      continue;
    }

    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content ?? "",
    });
  }

  flushToolResults();
  if (body.cache_strategy === "conversation" && messages.length >= 2) {
    const cacheIndex = messages.length - 2;
    const message = messages[cacheIndex];
    if (message && typeof message.content === "string" && message.content) {
      messages[cacheIndex] = {
        ...message,
        content: [{
          type: "text",
          text: message.content,
          cache_control: { type: "ephemeral" },
        }],
      };
    }
  }
  return messages;
}

export function anthropicTools(
  tools: CanonicalToolDefinition[] | null | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  const names = toolNameMap(tools);
  return tools.map((tool) => ({
    name: names.get(tool.name) ?? providerToolName(tool.name),
    description: tool.description,
    input_schema: tool.input_schema ?? { type: "object", properties: {} },
  }));
}

export function anthropicToolCalls(
  content: Array<{
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }> | null | undefined,
  tools: CanonicalToolDefinition[] | null | undefined,
): CanonicalToolCall[] {
  const reverseNames = toolReverseMap(tools);
  const toolCalls: CanonicalToolCall[] = [];
  for (const block of content ?? []) {
    if (block.type !== "tool_use" || !block.id || !block.name) continue;
    toolCalls.push({
      id: block.id,
      name: reverseNames.get(block.name) ?? block.name,
      arguments_json: jsonArguments(block.input ?? {}),
    });
  }
  return toolCalls;
}
