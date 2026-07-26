import type { CliStdioController } from "./localCliExecution";
import type { CanonicalUsage } from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  usageFromAcp,
  usageFromCodexCamelCase,
} from "./cliRuntimeMeasurement";

type ConversationProtocolAdapter = "claude_code" | "codex_cli" | "opencode";

export function createCliConversationController(input: {
  adapter_type: ConversationProtocolAdapter;
  prompt: string;
  cwd: string;
  model: string | null;
  sandbox_mode?: "read-only" | "workspace-write";
  runtime_session_id?: string | null;
  on_text_delta?: (delta: string) => void;
  on_protocol_event?: (event: Record<string, unknown>) => void;
}): CliStdioController | undefined {
  if (input.adapter_type === "codex_cli") {
    return new CodexAppServerController(input);
  }
  if (input.adapter_type === "opencode") {
    return new OpenCodeAcpController(input);
  }
  return undefined;
}

type Send = (message: Record<string, unknown>) => void;

const CODEX_ITEM_WITH_EMBEDDED_ITEM = new Set([
  "item/started",
  "item/completed",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
]);

const CODEX_ITEM_WITH_ITEM_ID = new Set([
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
]);

const CODEX_SCOPED_NOTIFICATIONS = new Set([
  "turn/diff/updated",
  "turn/plan/updated",
  "turn/moderationMetadata",
  "model/rerouted",
  "model/safetyBuffering/updated",
]);

class CodexAppServerController implements CliStdioController {
  private phase:
    | "initialize"
    | "thread_start"
    | "thread_resume"
    | "resume_usage"
    | "turn_start"
    | "running"
    | "terminal" = "initialize";
  private completed = false;
  private error: string | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private text = "";
  private usage: CanonicalUsage | null = null;
  private resumedUsageBaseline: CanonicalUsage | null = null;

  constructor(private readonly input: {
    prompt: string;
    cwd: string;
    model: string | null;
    sandbox_mode?: "read-only" | "workspace-write";
    runtime_session_id?: string | null;
    on_text_delta?: (delta: string) => void;
    on_protocol_event?: (event: Record<string, unknown>) => void;
  }) {}

  start(send: Send): void {
    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "agent_space",
          title: "Agent Space",
          version: "1",
        },
      },
    });
  }

  receive(message: Record<string, unknown>, send: Send, closeStdin: () => void): void {
    if (message.error) {
      this.fail(`Codex app-server RPC failed: ${rpcErrorMessage(message.error)}`, closeStdin);
      return;
    }
    if (isServerRequest(message)) {
      send({
        id: message.id,
        error: {
          code: -32601,
          message: `Agent Space does not permit interactive Codex request '${message.method}'`,
        },
      });
      this.fail(
        `Codex requested unsupported interactive method '${message.method}'`,
        closeStdin,
      );
      return;
    }
    if (message.id === 1 && this.phase === "initialize") {
      send({ method: "initialized", params: {} });
      if (this.input.runtime_session_id) {
        this.threadId = this.input.runtime_session_id;
        this.phase = "thread_resume";
        send({
          method: "thread/resume",
          id: 2,
          params: {
            threadId: this.input.runtime_session_id,
          },
        });
        return;
      }
      this.phase = "thread_start";
      send({
        method: "thread/start",
        id: 2,
        params: {
          cwd: this.input.cwd,
          approvalPolicy: "never",
          sandbox: this.input.sandbox_mode ?? "workspace-write",
          ...(this.input.model ? { model: this.input.model } : {}),
        },
      });
      return;
    }
    if (
      message.id === 2
      && (this.phase === "thread_start" || this.phase === "thread_resume")
    ) {
      const threadId = stringField(record(record(message.result).thread), "id");
      if (!threadId || (this.input.runtime_session_id && threadId !== this.input.runtime_session_id)) {
        this.fail("Codex app-server returned no thread id", closeStdin);
        return;
      }
      this.threadId = threadId;
      if (this.phase === "thread_resume") {
        this.phase = "resume_usage";
        return;
      }
      this.phase = "turn_start";
      this.startTurn(send);
      return;
    }
    if (message.id === 3 && this.phase === "turn_start") {
      const turnId = stringField(record(record(message.result).turn), "id");
      if (!turnId) {
        this.fail("Codex app-server returned no turn id", closeStdin);
        return;
      }
      this.turnId = turnId;
      this.phase = "running";
      return;
    }
    if (message.method === "turn/completed") {
      const params = record(message.params);
      const turn = record(params.turn);
      if (
        this.phase !== "running" ||
        stringField(params, "threadId") !== this.threadId ||
        stringField(turn, "id") !== this.turnId
      ) {
        this.fail("Codex app-server returned an out-of-order turn completion", closeStdin);
        return;
      }
      if (turn.status !== "completed") {
        this.fail(
          `Codex turn ended with status '${String(turn.status ?? "unknown")}'`,
          closeStdin,
        );
        return;
      }
      this.completed = true;
      this.phase = "terminal";
      closeStdin();
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const params = record(message.params);
      const delta = stringField(params, "delta");
      if (
        this.phase !== "running" ||
        stringField(params, "threadId") !== this.threadId ||
        stringField(params, "turnId") !== this.turnId ||
        !stringField(params, "itemId") ||
        delta === null
      ) {
        this.fail("Codex app-server returned an invalid agent-message delta", closeStdin);
        return;
      }
      this.text += delta;
      this.input.on_text_delta?.(delta);
      this.input.on_protocol_event?.(message);
      return;
    }
    if (message.method === "thread/started") {
      const startedThreadId = stringField(record(record(message.params).thread), "id");
      if (
        (
          this.phase !== "thread_resume"
          && this.phase !== "resume_usage"
          && this.phase !== "turn_start"
          && this.phase !== "running"
        )
        || startedThreadId !== this.threadId
      ) {
        this.fail("Codex app-server returned an out-of-scope thread start", closeStdin);
        return;
      }
      return;
    }
    if (message.method === "turn/started") {
      const params = record(message.params);
      const startedTurnId = stringField(record(params.turn), "id");
      if (
        this.phase !== "running"
        || stringField(params, "threadId") !== this.threadId
        || startedTurnId !== this.turnId
      ) {
        this.fail("Codex app-server returned an out-of-scope turn start", closeStdin);
        return;
      }
      return;
    }
    if (message.method === "thread/status/changed") {
      const params = record(message.params);
      if (
        (
          this.phase !== "resume_usage"
          && this.phase !== "turn_start"
          && this.phase !== "running"
          && this.phase !== "terminal"
        )
        || stringField(params, "threadId") !== this.threadId
      ) {
        this.fail("Codex app-server returned an out-of-scope thread status", closeStdin);
        return;
      }
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      const params = record(message.params);
      if (
        this.phase === "resume_usage"
        && stringField(params, "threadId") === this.threadId
      ) {
        const baseline = usageFromCodexCamelCase(record(record(params.tokenUsage).total));
        if (!baseline) {
          this.fail("Codex app-server returned invalid resumed token usage", closeStdin);
          return;
        }
        this.resumedUsageBaseline = baseline;
        this.phase = "turn_start";
        this.startTurn(send);
        return;
      }
      if (
        this.phase !== "running"
        || stringField(params, "threadId") !== this.threadId
        || stringField(params, "turnId") !== this.turnId
      ) {
        this.fail("Codex app-server returned out-of-scope token usage", closeStdin);
        return;
      }
      const usage = usageFromCodexCamelCase(record(record(params.tokenUsage).total));
      if (!usage) {
        this.fail("Codex app-server returned invalid token usage", closeStdin);
        return;
      }
      const turnUsage = this.resumedUsageBaseline
        ? subtractUsage(usage, this.resumedUsageBaseline)
        : usage;
      if (!turnUsage) {
        this.fail("Codex app-server token usage moved backwards after resume", closeStdin);
        return;
      }
      this.usage = turnUsage;
      return;
    }
    if (message.method === "mcpServer/startupStatus/updated") {
      const params = record(message.params);
      const name = stringField(params, "name");
      const status = stringField(params, "status");
      const eventThreadId = params.threadId === null ? null : stringField(params, "threadId");
      if (
        !name
        || !status
        || !["starting", "ready", "failed", "cancelled"].includes(status)
        || (eventThreadId !== null && eventThreadId !== this.threadId)
      ) {
        this.fail("Codex app-server returned an invalid MCP startup status", closeStdin);
        return;
      }
      if (status === "failed" || status === "cancelled") {
        this.fail(
          `Codex MCP server '${name}' startup ${status}`,
          closeStdin,
        );
      }
      return;
    }
    if (message.method === "warning") {
      const params = record(message.params);
      const eventThreadId = params.threadId === null ? null : stringField(params, "threadId");
      if (
        !stringField(params, "message")
        || (eventThreadId !== null && eventThreadId !== this.threadId)
      ) {
        this.fail("Codex app-server returned an invalid warning notification", closeStdin);
      }
      return;
    }
    if (message.method === "configWarning") {
      if (!stringField(record(message.params), "summary")) {
        this.fail("Codex app-server returned an invalid config warning", closeStdin);
      }
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      if (Object.keys(record(record(message.params).rateLimits)).length === 0) {
        this.fail("Codex app-server returned an invalid rate-limit notification", closeStdin);
      }
      return;
    }
    if (
      typeof message.method === "string"
      && (
        CODEX_ITEM_WITH_EMBEDDED_ITEM.has(message.method)
        || CODEX_ITEM_WITH_ITEM_ID.has(message.method)
      )
    ) {
      const params = record(message.params);
      const hasItemIdentity = CODEX_ITEM_WITH_EMBEDDED_ITEM.has(message.method)
        ? Boolean(stringField(record(params.item), "id"))
        : Boolean(stringField(params, "itemId"));
      if (
        this.phase !== "running" ||
        stringField(params, "threadId") !== this.threadId ||
        stringField(params, "turnId") !== this.turnId ||
        !hasItemIdentity
      ) {
        this.fail("Codex app-server returned an out-of-scope item event", closeStdin);
        return;
      }
      if (message.method === "item/started" || message.method === "item/completed") {
        this.input.on_protocol_event?.(message);
      }
      return;
    }
    if (typeof message.method === "string" && message.method.startsWith("item/")) {
      this.fail(`Codex app-server returned unknown item notification '${message.method}'`, closeStdin);
      return;
    }
    if (typeof message.method === "string" && CODEX_SCOPED_NOTIFICATIONS.has(message.method)) {
      const params = record(message.params);
      const eventThreadId = stringField(params, "threadId");
      const eventTurnId = stringField(params, "turnId");
      if (
        this.phase !== "running"
        || (eventThreadId !== null && eventThreadId !== this.threadId)
        || (eventTurnId !== null && eventTurnId !== this.turnId)
      ) {
        this.fail("Codex app-server returned an out-of-scope notification", closeStdin);
        return;
      }
      return;
    }
    if (message.method === "error") {
      this.fail(
        `Codex turn failed: ${rpcErrorMessage(record(message.params).error)}`,
        closeStdin,
      );
      return;
    }
    if (hasResponseId(message)) {
      this.fail(
        `Codex app-server returned unexpected response id '${String(message.id)}' during ${this.phase}`,
        closeStdin,
      );
      return;
    }
    this.fail("Codex app-server returned an unsupported protocol message", closeStdin);
  }

  result() {
    return {
      completed: this.completed,
      error: this.error,
      text: this.text,
      external_session_id: this.threadId,
      usage: this.usage,
    };
  }

  reject(message: string): void {
    if (!this.error) this.error = message;
  }

  private fail(message: string, closeStdin: () => void): void {
    this.error = message;
    closeStdin();
  }

  private startTurn(send: Send): void {
    send({
      method: "turn/start",
      id: 3,
      params: {
        threadId: this.threadId,
        input: [{ type: "text", text: this.input.prompt }],
      },
    });
  }
}

class OpenCodeAcpController implements CliStdioController {
  private phase: "initialize" | "session_new" | "set_model" | "prompt" | "terminal" = "initialize";
  private completed = false;
  private error: string | null = null;
  private sessionId: string | null = null;
  private text = "";
  private usage: CanonicalUsage | null = null;

  constructor(private readonly input: {
    prompt: string;
    cwd: string;
    model: string | null;
    runtime_session_id?: string | null;
    on_text_delta?: (delta: string) => void;
    on_protocol_event?: (event: Record<string, unknown>) => void;
  }) {}

  start(send: Send): void {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "agent-space", version: "1" },
      },
    });
  }

  receive(message: Record<string, unknown>, send: Send, closeStdin: () => void): void {
    if (message.jsonrpc !== "2.0") {
      this.fail("OpenCode ACP emitted a message without jsonrpc 2.0", closeStdin);
      return;
    }
    if (message.error) {
      this.fail(`OpenCode ACP RPC failed: ${rpcErrorMessage(message.error)}`, closeStdin);
      return;
    }
    if (isServerRequest(message)) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Agent Space does not permit interactive ACP request '${message.method}'`,
        },
      });
      this.fail(
        `OpenCode ACP requested unsupported interactive method '${message.method}'`,
        closeStdin,
      );
      return;
    }
    if (message.id === 1 && this.phase === "initialize") {
      if (record(message.result).protocolVersion !== 1) {
        this.fail("OpenCode ACP did not negotiate protocol version 1", closeStdin);
        return;
      }
      this.phase = "session_new";
      if (this.input.runtime_session_id) this.sessionId = this.input.runtime_session_id;
      send({
        jsonrpc: "2.0",
        id: 2,
        method: this.input.runtime_session_id ? "session/resume" : "session/new",
        params: {
          ...(this.input.runtime_session_id
            ? { sessionId: this.input.runtime_session_id }
            : {}),
          cwd: this.input.cwd,
          mcpServers: [],
        },
      });
      return;
    }
    if (message.id === 2 && this.phase === "session_new") {
      this.sessionId =
        this.input.runtime_session_id
        ?? stringField(record(message.result), "sessionId");
      if (!this.sessionId) {
        this.fail("OpenCode ACP returned no session id", closeStdin);
        return;
      }
      if (this.input.model) {
        this.phase = "set_model";
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "session/set_config_option",
          params: {
            sessionId: this.sessionId,
            configId: "model",
            value: this.input.model,
          },
        });
      } else {
        this.phase = "prompt";
        this.prompt(send);
      }
      return;
    }
    if (message.id === 3 && this.phase === "set_model") {
      const options = Array.isArray(record(message.result).configOptions)
        ? record(message.result).configOptions as unknown[]
        : [];
      const modelOption = options
        .map(record)
        .find((option) => option.id === "model");
      if (stringField(modelOption ?? {}, "currentValue") !== this.input.model) {
        this.fail("OpenCode ACP did not apply the requested model", closeStdin);
        return;
      }
      this.phase = "prompt";
      this.prompt(send);
      return;
    }
    if (message.id === 4 && this.phase === "prompt") {
      const result = record(message.result);
      const stopReason = stringField(result, "stopReason");
      if (stopReason !== "end_turn") {
        this.fail(
          `OpenCode ACP turn ended with stop reason '${stopReason ?? "unknown"}'`,
          closeStdin,
        );
        return;
      }
      const hasUsage = Object.prototype.hasOwnProperty.call(result, "usage");
      const rawUsage = recordOrNull(result.usage);
      const usage = rawUsage ? usageFromAcp(rawUsage) : null;
      if (hasUsage && !usage) {
        this.fail("OpenCode ACP returned invalid token usage", closeStdin);
        return;
      }
      this.usage = usage;
      this.completed = true;
      this.phase = "terminal";
      closeStdin();
      return;
    }
    if (message.method === "session/update") {
      const params = record(message.params);
      const update = record(params.update);
      if (stringField(params, "sessionId") !== this.sessionId) {
        this.fail("OpenCode ACP returned an out-of-scope session update", closeStdin);
        return;
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        if (this.phase !== "prompt") {
          this.fail("OpenCode ACP returned an out-of-order agent-message chunk", closeStdin);
          return;
        }
        const content = record(update.content);
        const delta = content.type === "text" ? stringField(content, "text") : null;
        if (delta === null) {
          this.fail("OpenCode ACP returned an invalid agent-message chunk", closeStdin);
          return;
        }
        this.text += delta;
        this.input.on_text_delta?.(delta);
      }
      if (this.phase !== "set_model" && this.phase !== "prompt") {
        this.fail("OpenCode ACP returned an out-of-order session update", closeStdin);
        return;
      }
      this.input.on_protocol_event?.(message);
      return;
    }
    if (hasResponseId(message)) {
      this.fail(
        `OpenCode ACP returned unexpected response id '${String(message.id)}' during ${this.phase}`,
        closeStdin,
      );
      return;
    }
    this.fail("OpenCode ACP returned an unsupported protocol message", closeStdin);
  }

  result() {
    return {
      completed: this.completed,
      error: this.error,
      text: this.text,
      external_session_id: this.sessionId,
      usage: this.usage,
    };
  }

  reject(message: string): void {
    if (!this.error) this.error = message;
  }

  private prompt(send: Send): void {
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: this.input.prompt }],
      },
    });
  }

  private fail(message: string, closeStdin: () => void): void {
    this.error = message;
    closeStdin();
  }
}

function record(value: unknown): Record<string, unknown> {
  return recordOrNull(value) ?? {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" && value[key] ? value[key] : null;
}

function rpcErrorMessage(value: unknown): string {
  const error = record(value);
  return stringField(error, "message") ?? "unknown protocol error";
}

function isServerRequest(message: Record<string, unknown>): message is Record<string, unknown> & {
  id: string | number;
  method: string;
} {
  return (typeof message.id === "string" || typeof message.id === "number")
    && typeof message.method === "string";
}

function hasResponseId(message: Record<string, unknown>): boolean {
  return typeof message.id === "string" || typeof message.id === "number";
}

function subtractUsage(
  current: CanonicalUsage,
  baseline: CanonicalUsage,
): CanonicalUsage | null {
  const result: CanonicalUsage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "reasoning_tokens",
  ] as const) {
    const currentValue = current[key];
    const baselineValue = baseline[key];
    if (currentValue === undefined || baselineValue === undefined) return null;
    const delta = currentValue - baselineValue;
    if (delta < 0) return null;
    result[key] = delta;
  }
  return result;
}
