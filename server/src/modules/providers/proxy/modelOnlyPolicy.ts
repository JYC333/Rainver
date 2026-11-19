import type { ProviderProxyRoute } from "./lease.js";

/**
 * The request capability of a `model_only` lease — the lease a network-isolated
 * Run reaches through its model channel (ADR 0030 §4a).
 *
 * The Run's namespace blocks every destination but this lease, so whatever the
 * provider would do *on the Run's behalf* is the remaining egress: fetch a URL
 * named in an image or document, run hosted web search or code execution,
 * connect to an MCP server, read or create files and batches, or reach a stored
 * response. A model-only lease therefore carries a closed capability, judged
 * here, at the proxy, for every request on the lease — whichever path or
 * endpoint it arrives through, the token is the lease's and so is this check:
 *
 * - exactly the inference endpoints the bound CLIs call: Anthropic Messages
 *   (`POST /v1/messages`, `/v1/messages/count_tokens`; Claude Code and
 *   OpenCode's Anthropic package), OpenAI Responses (`POST /responses`; Codex)
 *   and Chat Completions (`POST /chat/completions`; OpenCode's OpenAI-compatible
 *   package). No GET, no other path, no file, batch, model-listing or stored-
 *   resource endpoint;
 * - a JSON body whose `model` is present and is the lease's model;
 * - every field, at every level this policy reads, on an allowlist built from
 *   what those CLIs actually send (captured from the installed binaries against
 *   a synthetic provider). An unknown field, block type or tool type is refused,
 *   never passed on: a field this code does not know may be a provider feature
 *   that egresses;
 * - nothing stored at the provider: Responses must say `store: false` (its
 *   default is to store); Chat Completions may only omit it or say `false`;
 * - tools are the CLI's own: client-executed function/custom definitions (and
 *   Codex's local shell and function namespaces). Every hosted/server tool —
 *   web search or fetch, code execution, computer use, MCP, file search, tool
 *   search, image generation — is refused, as is any image or document given
 *   by URL or provider file id — in a message or in a tool's output, which
 *   carries the same content blocks. Inline (base64 / `data:`) content is allowed.
 *
 * Streaming responses pass through unchanged; only the request is judged.
 * Returns the refusal reason, or null when the request is within the lease.
 */
/** One parse of a proxied request body, shared by every lease check; null when it is not JSON. */
export function parseRequestJson(body: Buffer): { value: unknown } | null {
  try {
    return { value: JSON.parse(body.toString("utf8")) };
  } catch {
    return null;
  }
}

export function modelOnlyRequestRefusal(input: {
  route: ProviderProxyRoute;
  method: string | undefined;
  path: string;
  search: string;
  contentType: string | undefined;
  /** The request body parsed once by the proxy (`parseRequestJson`); null when it is not JSON. */
  json: { value: unknown } | null;
  model: string | null;
}): string | null {
  if ((input.method ?? "GET").toUpperCase() !== "POST") return "method_not_allowed";
  const endpoint = ENDPOINTS[input.route][input.path];
  if (!endpoint) return "endpoint_not_allowed";
  const query = new URLSearchParams(input.search);
  for (const [key, value] of query) {
    if (!(endpoint.query?.[key]?.includes(value))) return "query_not_allowed";
  }
  if (!/^application\/json(\s*;|$)/i.test(input.contentType ?? "")) return "body_not_json";
  const body = input.json?.value;
  if (!isRecord(body)) return "body_not_json";
  if (!input.model) return "lease_has_no_model";
  if (body.model !== input.model) return "model_not_leased";
  try {
    endpoint.check(body);
  } catch (error) {
    if (error instanceof Refusal) return error.reason;
    throw error;
  }
  return null;
}

class Refusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

/** Every key of `value` is in `allowed`; returns it as a record. */
function only(value: unknown, allowed: readonly string[], where: string): Json {
  if (!isRecord(value)) refuse(`${where}_not_object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse(`${where}_field_not_allowed:${key}`);
  return value;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) refuse(`${where}_not_array`);
  return value;
}

function oneOf(value: unknown, allowed: readonly unknown[], where: string): void {
  if (!allowed.includes(value)) refuse(`${where}_not_allowed`);
}

/** A string, or an array of blocks each checked by `block`. */
function textOrBlocks(value: unknown, block: (item: unknown) => void, where: string): void {
  if (typeof value === "string") return;
  for (const item of list(value, where)) block(item);
}

// ── Anthropic Messages ──────────────────────────────────────────────────────

const CACHE = ["cache_control"] as const;

/** Inline sources only: a URL or a provider file id would have the provider fetch for the Run. */
function anthropicSource(value: unknown, kinds: readonly string[], where: string): void {
  const source = only(value, ["type", "media_type", "data"], where);
  oneOf(source.type, kinds, `${where}_type`);
}

function anthropicBlock(value: unknown, where: string, nested = false): void {
  if (!isRecord(value)) refuse(`${where}_not_object`);
  switch (value.type) {
    case "text":
      only(value, ["type", "text", ...CACHE, "citations"], where);
      return;
    case "image":
      anthropicSource(only(value, ["type", "source", ...CACHE], where).source, ["base64"], `${where}_source`);
      return;
    case "document":
      anthropicSource(only(value, ["type", "source", "title", "context", "citations", ...CACHE], where).source, ["base64", "text"], `${where}_source`);
      return;
    case "tool_use":
      if (nested) break;
      only(value, ["type", "id", "name", "input", ...CACHE], where);
      return;
    case "tool_result": {
      if (nested) break;
      const result = only(value, ["type", "tool_use_id", "content", "is_error", ...CACHE], where);
      if (result.content !== undefined) textOrBlocks(result.content, (item) => anthropicBlock(item, `${where}_content`, true), `${where}_content`);
      return;
    }
    case "thinking":
      if (nested) break;
      only(value, ["type", "thinking", "signature"], where);
      return;
    case "redacted_thinking":
      if (nested) break;
      only(value, ["type", "data"], where);
      return;
  }
  refuse(`${where}_type_not_allowed`);
}

function anthropicMessages(body: Json, countTokens: boolean): void {
  only(body, countTokens
    ? ["model", "messages", "system", "tools", "tool_choice", "thinking", "context_management", "output_config"]
    : ["model", "messages", "system", "max_tokens", "metadata", "stream", "temperature", "top_p", "top_k", "stop_sequences",
      "tools", "tool_choice", "thinking", "context_management", "output_config"], "body");
  for (const message of list(body.messages, "messages")) {
    const m = only(message, ["role", "content"], "message");
    oneOf(m.role, ["user", "assistant", "system"], "message_role");
    textOrBlocks(m.content, (item) => anthropicBlock(item, "content"), "message_content");
  }
  if (body.system !== undefined) {
    textOrBlocks(body.system, (item) => {
      if (!isRecord(item) || item.type !== "text") refuse("system_type_not_allowed");
      only(item, ["type", "text", ...CACHE], "system");
    }, "system");
  }
  if (body.metadata !== undefined) only(body.metadata, ["user_id"], "metadata");
  for (const tool of body.tools === undefined ? [] : list(body.tools, "tools")) {
    // A typed tool is a server tool (web search/fetch, code execution, MCP,
    // tool search, …) or a provider-defined client tool; only plain custom
    // tools are the CLI's own. `allowed_callers` would let a server tool call it.
    const t = only(tool, ["type", "name", "description", "input_schema", ...CACHE, "defer_loading", "strict", "input_examples"], "tool");
    if (t.type !== undefined) oneOf(t.type, ["custom"], "tool_type");
    if (typeof t.name !== "string" || !isRecord(t.input_schema)) refuse("tool_not_custom");
  }
  if (body.tool_choice !== undefined) {
    const choice = only(body.tool_choice, ["type", "name", "disable_parallel_tool_use"], "tool_choice");
    oneOf(choice.type, ["auto", "any", "tool", "none"], "tool_choice_type");
  }
  if (body.thinking !== undefined) {
    const thinking = only(body.thinking, ["type", "budget_tokens", "display"], "thinking");
    oneOf(thinking.type, ["enabled", "disabled", "adaptive"], "thinking_type");
  }
  if (body.context_management !== undefined) {
    for (const edit of list(only(body.context_management, ["edits"], "context_management").edits, "context_management_edits")) {
      const e = only(edit, ["type", "keep", "trigger", "clear_at_least", "clear_tool_inputs", "exclude_tools"], "context_edit");
      if (typeof e.type !== "string" || !/^clear_(thinking|tool_uses)_\d{8}$/.test(e.type)) refuse("context_edit_type_not_allowed");
    }
  }
  if (body.output_config !== undefined) {
    const output = only(body.output_config, ["effort", "format"], "output_config");
    if (output.format !== undefined) oneOf(only(output.format, ["type", "schema"], "output_format").type, ["json_schema"], "output_format_type");
  }
}

// ── OpenAI Responses (Codex) ────────────────────────────────────────────────

/** Inline images only (`data:`); an http(s) URL or a file id is a provider-side fetch. */
function inlineImageUrl(value: unknown, where: string): void {
  const url = typeof value === "string" ? value : isRecord(value) ? only(value, ["url", "detail"], where).url : null;
  if (typeof url !== "string" || !url.startsWith("data:")) refuse(`${where}_not_inline`);
}

/**
 * Responses content, wherever it is model input: a message's `content`, and a
 * tool output (`function_call_output` / `custom_tool_call_output`), which may
 * be a string or the same content array — a tool can hand back an image or a
 * file, and one named by URL or file id is a provider-side fetch. Inline only.
 */
function responsesContent(value: unknown, where: string): void {
  textOrBlocks(value, (item) => {
    if (!isRecord(item)) refuse(`${where}_not_object`);
    switch (item.type) {
      case "input_text":
        only(item, ["type", "text"], where);
        return;
      case "output_text": {
        const text = only(item, ["type", "text", "annotations", "logprobs"], where);
        // A replayed annotation is a citation of a hosted tool's (file/web) result.
        if (text.annotations !== undefined && list(text.annotations, `${where}_annotations`).length > 0) refuse(`${where}_annotations_not_allowed`);
        if (text.logprobs !== undefined) list(text.logprobs, `${where}_logprobs`);
        return;
      }
      case "refusal":
        only(item, ["type", "refusal"], where);
        return;
      case "input_image":
        inlineImageUrl(only(item, ["type", "image_url", "detail"], where).image_url, `${where}_image`);
        return;
      case "input_file": {
        // `file_data` is inline; `file_url` and `file_id` are not on the allowlist.
        const file = only(item, ["type", "file_data", "filename"], where);
        if (typeof file.file_data !== "string") refuse(`${where}_file_not_inline`);
        return;
      }
    }
    refuse(`${where}_type_not_allowed`);
  }, where);
}

/** Reasoning `summary` / `content` parts: text only. */
function reasoningParts(value: unknown, type: string, where: string): void {
  for (const part of list(value, where)) {
    if (!isRecord(part) || part.type !== type) refuse(`${where}_type_not_allowed`);
    only(part, ["type", "text"], where);
  }
}

const RESPONSES_ITEM_FIELDS: Record<string, readonly string[]> = {
  message: ["type", "id", "role", "content", "status"],
  function_call: ["type", "id", "call_id", "name", "namespace", "arguments", "status"],
  function_call_output: ["type", "id", "call_id", "output", "status"],
  custom_tool_call: ["type", "id", "call_id", "name", "input", "status"],
  custom_tool_call_output: ["type", "id", "call_id", "output", "status"],
  local_shell_call: ["type", "id", "call_id", "action", "status"],
  local_shell_call_output: ["type", "id", "call_id", "output", "status"],
  reasoning: ["type", "id", "summary", "content", "encrypted_content", "status"],
};

/**
 * Every model-input value of an allowed item, by item type. A field in
 * RESPONSES_ITEM_FIELDS that carries content is checked here, never passed on.
 */
function responsesItem(type: string, item: Json): void {
  switch (type) {
    case "message":
      oneOf(item.role, ["user", "assistant", "system", "developer"], "input_role");
      responsesContent(item.content, "input_content");
      return;
    case "function_call_output":
    case "custom_tool_call_output":
      responsesContent(item.output, "tool_output");
      return;
    case "local_shell_call_output":
      // A local shell's output is its text; there is no content-array form.
      if (typeof item.output !== "string") refuse("local_shell_output_not_string");
      return;
    case "function_call":
    case "custom_tool_call":
      // The model's own call, replayed: strings the CLI executed locally.
      if (typeof item.name !== "string") refuse("tool_call_name_not_string");
      if (typeof (type === "function_call" ? item.arguments : item.input) !== "string") refuse("tool_call_input_not_string");
      if (item.namespace !== undefined && typeof item.namespace !== "string") refuse("tool_call_namespace_not_string");
      return;
    case "local_shell_call":
      only(item.action, ["type", "command", "env", "timeout_ms", "user", "working_directory"], "local_shell_action");
      return;
    case "reasoning":
      if (item.summary !== undefined) reasoningParts(item.summary, "summary_text", "reasoning_summary");
      if (item.content !== undefined && item.content !== null) reasoningParts(item.content, "reasoning_text", "reasoning_content");
      if (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== "string") refuse("reasoning_encrypted_not_string");
      return;
  }
}

function responsesTool(value: unknown, inNamespace: boolean): void {
  if (!isRecord(value)) refuse("tool_not_object");
  switch (value.type) {
    case "function":
      only(value, ["type", "name", "description", "parameters", "strict"], "tool");
      return;
    case "custom":
      only(value, ["type", "name", "description", "format"], "tool");
      return;
    case "local_shell":
      if (inNamespace) break;
      only(value, ["type"], "tool");
      return;
    case "namespace":
      if (inNamespace) break;
      for (const tool of list(only(value, ["type", "name", "description", "tools"], "tool").tools, "namespace_tools")) responsesTool(tool, true);
      return;
  }
  // web_search*, file_search, code_interpreter, computer_use*, mcp,
  // image_generation, tool_search, … run at the provider.
  refuse("tool_type_not_allowed");
}

function responses(body: Json): void {
  only(body, ["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream",
    "include", "prompt_cache_key", "client_metadata", "text", "max_output_tokens", "temperature", "top_p", "metadata",
    "truncation", "service_tier"], "body");
  // A stored response is a provider-side resource the lease could not read
  // back anyway. Responses stores by default, so only an explicit `false` —
  // what Codex sends — is within the lease; omitted, `true` or anything else
  // is refused rather than rewritten.
  if (body.store !== false) refuse("store_not_false");
  const input = body.input;
  if (typeof input !== "string") {
    for (const item of list(input, "input")) {
      if (!isRecord(item)) refuse("input_item_not_object");
      const type = item.type ?? (item.role !== undefined ? "message" : undefined);
      const fields = typeof type === "string" ? RESPONSES_ITEM_FIELDS[type] : undefined;
      if (!fields) refuse("input_item_type_not_allowed");
      only(item, fields, "input_item");
      responsesItem(type as string, item);
    }
  }
  for (const tool of body.tools === undefined ? [] : list(body.tools, "tools")) responsesTool(tool, false);
  if (body.tool_choice !== undefined && typeof body.tool_choice !== "string") {
    oneOf(only(body.tool_choice, ["type", "name"], "tool_choice").type, ["function", "custom"], "tool_choice_type");
  } else if (body.tool_choice !== undefined) oneOf(body.tool_choice, ["auto", "none", "required"], "tool_choice");
  if (body.include !== undefined) {
    for (const value of list(body.include, "include")) oneOf(value, ["reasoning.encrypted_content", "message.output_text.logprobs"], "include");
  }
  if (body.reasoning !== undefined) only(body.reasoning, ["effort", "summary"], "reasoning");
  if (body.text !== undefined) {
    const text = only(body.text, ["format", "verbosity"], "text");
    if (text.format !== undefined) oneOf(only(text.format, ["type", "name", "schema", "strict", "description"], "text_format").type, ["text", "json_schema", "json_object"], "text_format_type");
  }
}

// ── OpenAI Chat Completions (OpenCode, OpenAI-compatible) ───────────────────

function chatCompletions(body: Json): void {
  only(body, ["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options", "temperature",
    "top_p", "max_tokens", "max_completion_tokens", "stop", "seed", "presence_penalty", "frequency_penalty",
    "response_format", "reasoning_effort", "user", "store"], "body");
  // Chat Completions does not store unless asked; only an explicit `false` may be sent.
  if (body.store !== undefined && body.store !== false) refuse("store_not_allowed");
  for (const message of list(body.messages, "messages")) {
    const m = only(message, ["role", "content", "name", "tool_calls", "tool_call_id", "reasoning_content"], "message");
    oneOf(m.role, ["system", "developer", "user", "assistant", "tool"], "message_role");
    if (m.content !== undefined && m.content !== null) {
      textOrBlocks(m.content, (item) => {
        if (!isRecord(item)) refuse("content_not_object");
        if (item.type === "text") only(item, ["type", "text"], "content");
        else if (item.type === "image_url") inlineImageUrl(only(item, ["type", "image_url"], "content").image_url, "image_url");
        else refuse("content_type_not_allowed");
      }, "message_content");
    }
    for (const call of m.tool_calls === undefined ? [] : list(m.tool_calls, "tool_calls")) {
      const c = only(call, ["id", "type", "function", "index"], "tool_call");
      oneOf(c.type, ["function"], "tool_call_type");
      only(c.function, ["name", "arguments"], "tool_call_function");
    }
  }
  for (const tool of body.tools === undefined ? [] : list(body.tools, "tools")) {
    const t = only(tool, ["type", "function"], "tool");
    oneOf(t.type, ["function"], "tool_type");
    only(t.function, ["name", "description", "parameters", "strict"], "tool_function");
  }
  if (body.tool_choice !== undefined && typeof body.tool_choice !== "string") {
    oneOf(only(body.tool_choice, ["type", "function"], "tool_choice").type, ["function"], "tool_choice_type");
  } else if (body.tool_choice !== undefined) oneOf(body.tool_choice, ["auto", "none", "required"], "tool_choice");
  if (body.stream_options !== undefined) only(body.stream_options, ["include_usage"], "stream_options");
  if (body.response_format !== undefined) oneOf(only(body.response_format, ["type", "json_schema"], "response_format").type, ["text", "json_schema", "json_object"], "response_format_type");
}

interface Endpoint {
  /** Query parameters allowed, with their allowed values. */
  query?: Record<string, readonly string[]>;
  check: (body: Json) => void;
}

const ENDPOINTS: Record<ProviderProxyRoute, Record<string, Endpoint>> = {
  anthropic: {
    // Claude Code adds `?beta=true` to the Messages endpoint.
    "/v1/messages": { query: { beta: ["true"] }, check: (body) => anthropicMessages(body, false) },
    "/v1/messages/count_tokens": { query: { beta: ["true"] }, check: (body) => anthropicMessages(body, true) },
  },
  openai: {
    "/responses": { check: responses },
    "/chat/completions": { check: chatCompletions },
  },
};
