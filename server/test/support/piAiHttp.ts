type JsonRecord = Record<string, unknown>;

export interface ScriptedHttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

/** Convert the pre-Pi scripted JSON fixture shape into Pi's actual SSE wire. */
export function openAiChatResponse(payload: unknown, status = 200): Response {
  if (status < 200 || status >= 300) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  const data = record(payload);
  const choice = record(Array.isArray(data.choices) ? data.choices[0] : null);
  const message = Object.keys(record(choice.message)).length ? record(choice.message) : record(data.message);
  const model = typeof data.model === "string" ? data.model : "test-model";
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const events: JsonRecord[] = [{
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        ...(typeof message.content === "string" && message.content ? { content: message.content } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls.map((call, index) => {
          const item = record(call);
          return { index, id: item.id, type: item.type ?? "function", function: item.function };
        }) } : {}),
      },
      finish_reason: null,
    }],
  }, {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: choice.finish_reason ?? (toolCalls.length ? "tool_calls" : "stop"),
    }],
  }];
  if (data.usage) {
    events.push({
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [],
      usage: data.usage,
    });
  }
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Convert a scripted Anthropic Messages JSON fixture into its SSE wire. */
export function anthropicChatResponse(payload: unknown, status = 200): Response {
  if (status < 200 || status >= 300) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  const data = record(payload);
  const model = typeof data.model === "string" ? data.model : "test-model";
  const usage = record(data.usage);
  const blocks = Array.isArray(data.content) ? data.content.map(record) : [];
  const events: JsonRecord[] = [{
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens ?? 0, ...usage },
    },
  }];
  blocks.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      });
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: typeof block.text === "string" ? block.text : "" },
      });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: data.stop_reason ?? (blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn"), stop_sequence: null },
    usage: { output_tokens: usage.output_tokens ?? 0, ...usage },
  });
  events.push({ type: "message_stop" });
  return new Response(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Keep existing raw-HTTP scripts while presenting the streaming wire pi-ai consumes. */
export function piAiHttpClient(client: ScriptedHttpClient): ScriptedHttpClient {
  return {
    async fetch(url, init) {
      const response = await client.fetch(url, init);
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
      if (!String(url).includes("/chat/completions") && !String(url).endsWith("/messages")) return response;
      const payload: unknown = await response.json();
      return String(url).endsWith("/messages")
        ? anthropicChatResponse(payload, response.status)
        : openAiChatResponse(payload, response.status);
    },
  };
}
