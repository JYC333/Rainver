import type { CliStdioController } from "./localCliExecution.js";
import type {
  CanonicalModelUsage,
  CanonicalUsage,
} from "@rainver/protocol";
// D6 (twice-corrected, execution-topology-and-project-control-plane-plan.md
// §6): the phase dispatcher below stays hand-rolled — no SDK hook reproduces
// its tested start()-independent, phase-named anomaly handling — but its
// wire shapes are checked against the SDK's own authoritative schema types
// here, rather than trusted by convention alone.
import type { PermissionOption } from "@agentclientprotocol/sdk";
import { usageFromAcp } from "./cliRuntimeMeasurement.js";
import { decidePermission, type PermissionDecisionRecord } from "./runPermissionPolicy.js";
import { getRuntimeAdapterSpec, isAcpRuntimeAdapter, type VendorCliAdapterType } from "../runtimeAdapters/specs.js";

type ConversationProtocolAdapter = VendorCliAdapterType;

export interface AcpSessionConfigSelection {
  id: string;
  type: "select" | "boolean";
  value: string | boolean;
  category: string | null;
}

export function acpSessionConfigFromRunOverride(value: unknown): AcpSessionConfigSelection[] {
  const candidate = record(value).acp_session_config;
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((entry) => {
    const item = record(entry);
    const id = stringField(item, "id");
    const type = item.type === "select" || item.type === "boolean" ? item.type : null;
    const category = typeof item.category === "string" ? item.category : item.category === null ? null : undefined;
    const validValue = type === "select" ? typeof item.value === "string" : typeof item.value === "boolean";
    return id && type && category !== undefined && validValue
      ? [{ id, type, value: item.value as string | boolean, category }]
      : [];
  });
}

export function withAcpModelSelection(
  selections: AcpSessionConfigSelection[],
  model: string | null,
): AcpSessionConfigSelection[] {
  if (!model) return selections;
  return [
    ...selections.filter((selection) => selection.category !== "model"),
    { id: "model", type: "select", value: model, category: "model" },
  ];
}

export function createCliConversationController(input: {
  adapter_type: ConversationProtocolAdapter;
  prompt?: string;
  prompts?: string[];
  cwd: string;
  session_config?: AcpSessionConfigSelection[];
  sandbox_mode?: "read-only" | "workspace-write";
  runtime_session_id?: string | null;
  before_next_prompt?: (sessionId: string) => Promise<void>;
  on_text_delta?: (delta: string) => void;
  /**
   * Reasoning, on the channel a runtime uses when it keeps reasoning separate
   * from its answer. Delivered apart from `on_text_delta` so the two never
   * have to be told apart downstream by inspecting the text.
   */
  on_thought_delta?: (delta: string) => void;
  /**
   * What this run actually executes against, when the caller already knows —
   * a bound run's provider model. Distinct from the model-category ACP
   * selection, whose identifier can live in the runtime's own namespace.
   *
   * When present it is the authority, because it is the server's own decision
   * — the environment and config it wrote are what the runtime obeys. Reading
   * the runtime's echo instead would report an alias (`default`) or, on a
   * resumed session, the previous turn's model.
   */
  attributed_model?: string | null;
  on_protocol_event?: (event: Record<string, unknown>) => void;
  /**
   * execution-topology-and-project-control-plane-plan.md P0.4/D7: fired once
   * per permission request, whatever the outcome, so a caller with a durable
   * event stream (a remote dispatch's task thread) can record that this Run
   * was pre-authorized rather than leaving it implicit. Callers with no such
   * stream (a server-host sandboxed Run) may omit it; the decision itself is
   * unaffected either way.
   */
  on_permission_decision?: (record: PermissionDecisionRecord) => void;
}): CliStdioController | undefined {
  const prompts = input.prompts?.filter((prompt) => prompt.trim())
    ?? (input.prompt?.trim() ? [input.prompt] : []);
  if (prompts.length === 0) return undefined;
  const normalized = { ...input, prompts };
  if (isAcpRuntimeAdapter(input.adapter_type)) return new AcpController(normalized);
  return undefined;
}

type Send = (message: Record<string, unknown>) => void;

/**
 * General Agent Client Protocol controller. All three conversation runtimes
 * use the same lifecycle on both server-host and remote paths; Claude's ACP
 * adapter replaced its stream-json path in P4 of the runtime replatform.
 */
export class AcpController implements CliStdioController {
  private phase: "initialize" | "session_new" | "set_config" | "prompt" | "phase_acknowledge" | "terminal" = "initialize";
  private completed = false;
  private error: string | null = null;
  private resumeHandshakeFailed = false;
  private configIndex = 0;
  private activeConfigRequestId: number | null = null;
  private advertisedConfigOptions: Record<string, unknown>[] = [];
  private sessionId: string | null = null;
  private text = "";
  private usage: CanonicalUsage | null = null;
  private modelUsage: CanonicalModelUsage[] = [];
  private selectedModel: string | null;
  private subscriptionQuota: {
    status: string;
    rate_limit_type: string;
    utilization: number;
    resets_at: number;
    is_using_overage: boolean;
  } | null = null;
  private promptIndex = 0;

  constructor(private readonly input: {
    adapter_type: ConversationProtocolAdapter;
    prompts: string[];
    cwd: string;
    session_config?: AcpSessionConfigSelection[];
    runtime_session_id?: string | null;
    before_next_prompt?: (sessionId: string) => Promise<void>;
    on_text_delta?: (delta: string) => void;
    on_thought_delta?: (delta: string) => void;
    attributed_model?: string | null;
    on_protocol_event?: (event: Record<string, unknown>) => void;
    on_permission_decision?: (record: PermissionDecisionRecord) => void;
  }) {
    this.selectedModel = input.attributed_model ?? null;
  }

  start(send: Send): void {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: "rainver", version: "1" },
      },
    });
  }

  // Async only to match `CliStdioController`'s interface (shared with
  // `CodexQuotaController`'s unrelated app-server RPC, which does need it —
  // see localCliExecution.ts). This body stays fully synchronous: every
  // `send()` this method needs to produce still happens before it returns,
  // preserving the ~58 existing synchronous test call sites that assert on
  // `send()` output with no `await` at the call site (execution-topology-
  // and-project-control-plane-plan.md §6 D6, twice-corrected there).
  // eslint-disable-next-line @typescript-eslint/require-await
  async receive(message: Record<string, unknown>, send: Send, closeStdin: () => void): Promise<void> {
    if (message.jsonrpc !== "2.0") {
      this.fail(`${this.label()} ACP emitted a message without jsonrpc 2.0`, closeStdin);
      return;
    }
    if (message.error) {
      if (this.phase === "session_new" && message.id === 2 && this.input.runtime_session_id) {
        this.resumeHandshakeFailed = true;
      }
      this.fail(`${this.label()} ACP RPC failed: ${rpcErrorMessage(message.error)}`, closeStdin);
      return;
    }
    if (isServerRequest(message) && message.method === "session/request_permission") {
      this.approvePermissionRequest(message, send, closeStdin);
      return;
    }
    if (isServerRequest(message)) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Rainver does not permit interactive ACP request '${message.method}'`,
        },
      });
      this.fail(
        `${this.label()} ACP requested unsupported interactive method '${message.method}'`,
        closeStdin,
      );
      return;
    }
    if (message.id === 1 && this.phase === "initialize") {
      if (record(message.result).protocolVersion !== 1) {
        this.fail(`${this.label()} ACP did not negotiate protocol version 1`, closeStdin);
        return;
      }
      this.input.on_protocol_event?.(message);
      this.phase = "session_new";
      if (this.input.runtime_session_id) this.sessionId = this.input.runtime_session_id;
      this.captureSelectedModel(record(message.result));
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
      this.captureSelectedModel(record(message.result));
      if (!this.sessionId) {
        this.fail(`${this.label()} ACP returned no session id`, closeStdin);
        return;
      }
      this.captureConfigOptions(record(message.result));
      if (!this.sendNextConfig(send, closeStdin)) {
        this.phase = "prompt";
        this.prompt(send);
      }
      return;
    }
    if (this.phase === "set_config" && message.id === this.activeConfigRequestId) {
      const selection = this.orderedConfig()[this.configIndex];
      if (!selection || !Array.isArray(record(message.result).configOptions)) {
        this.fail(`${this.label()} ACP returned no config options after applying a session option`, closeStdin);
        return;
      }
      this.captureConfigOptions(record(message.result));
      const appliedOption = this.advertisedConfigOptions.find((option) => option.id === selection.id);
      if (!appliedOption || appliedOption.currentValue !== selection.value) {
        this.fail(
          `${this.label()} ACP did not apply session option '${selection.id}' `
            + `(asked for '${String(selection.value)}', runtime is on `
            + `'${String(appliedOption?.currentValue ?? "none")}')`,
          closeStdin,
        );
        return;
      }
      if (selection.category === "model" && !this.input.attributed_model) {
        this.selectedModel = String(selection.value);
      }
      this.configIndex += 1;
      if (!this.sendNextConfig(send, closeStdin)) {
        this.phase = "prompt";
        this.prompt(send);
      }
      return;
    }
    if (message.id === 4 + this.promptIndex && this.phase === "prompt") {
      const result = record(message.result);
      const stopReason = stringField(result, "stopReason");
      if (stopReason !== "end_turn") {
        this.fail(
          `${this.label()} ACP turn ended with stop reason '${stopReason ?? "unknown"}'`,
          closeStdin,
        );
        return;
      }
      const hasUsage = Object.prototype.hasOwnProperty.call(result, "usage");
      const rawUsage = recordOrNull(result.usage);
      const usage = rawUsage ? usageFromAcp(rawUsage) : null;
      if (hasUsage && !usage) {
        this.fail(`${this.label()} ACP returned invalid token usage`, closeStdin);
        return;
      }
      this.usage = addUsage(this.usage, usage);
      if (this.input.adapter_type === "claude_code" && this.selectedModel && usage) {
        this.modelUsage = addModelUsage(this.modelUsage, this.selectedModel, usage);
      }
      if (this.promptIndex + 1 < this.input.prompts.length) {
        this.phase = "phase_acknowledge";
        const acknowledge = this.input.before_next_prompt?.(this.sessionId!);
        Promise.resolve(acknowledge).then(() => {
          if (this.phase !== "phase_acknowledge") return;
          this.promptIndex += 1;
          this.text = "";
          this.phase = "prompt";
          this.prompt(send);
        }, (error) => this.fail(
          error instanceof Error ? error.message : "CLI context acknowledgement failed",
          closeStdin,
        ));
      } else {
        this.completed = true;
        this.phase = "terminal";
        closeStdin();
      }
      return;
    }
    if (message.method === "session/update") {
      const params = record(message.params);
      const update = record(params.update);
      if (stringField(params, "sessionId") !== this.sessionId) {
        this.fail(`${this.label()} ACP returned an out-of-scope session update`, closeStdin);
        return;
      }
      this.captureSubscriptionQuota(params, update);
      if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
        const thought = update.sessionUpdate === "agent_thought_chunk";
        if (this.phase !== "prompt") {
          this.fail(
            `${this.label()} ACP returned an out-of-order ${thought ? "agent-thought" : "agent-message"} chunk`,
            closeStdin,
          );
          return;
        }
        const content = record(update.content);
        const delta = content.type === "text" ? stringField(content, "text") : null;
        if (delta === null) {
          this.fail(
            `${this.label()} ACP returned an invalid ${thought ? "agent-thought" : "agent-message"} chunk`,
            closeStdin,
          );
          return;
        }
        if (this.promptIndex === this.input.prompts.length - 1) {
          // Reasoning is deliberately kept out of `this.text`: that is the
          // turn's answer, and it feeds output_text and the measurement
          // fallback.
          if (thought) {
            this.input.on_thought_delta?.(delta);
          } else {
            this.text += delta;
            this.input.on_text_delta?.(delta);
          }
        }
      }
      if (update.sessionUpdate === "config_option_update") {
        this.captureConfigOptions(update);
      }
      if (this.phase !== "set_config" && this.phase !== "prompt") {
        this.fail(`${this.label()} ACP returned an out-of-order session update`, closeStdin);
        return;
      }
      if (this.promptIndex === this.input.prompts.length - 1) {
        this.input.on_protocol_event?.(message);
      }
      return;
    }
    if (hasResponseId(message)) {
      this.fail(
        `${this.label()} ACP returned unexpected response id '${String(message.id)}' during ${this.phase}`,
        closeStdin,
      );
      return;
    }
    this.fail(`${this.label()} ACP returned an unsupported protocol message`, closeStdin);
  }

  result() {
    return {
      completed: this.completed,
      error: this.error,
      ...(this.resumeHandshakeFailed ? { resume_handshake_failed: true } : {}),
      text: this.text,
      external_session_id: this.sessionId,
      usage: this.usage,
      model_usage: this.modelUsage,
      subscription_quota: this.subscriptionQuota,
    };
  }

  reject(message: string): void {
    if (!this.error) this.error = message;
  }

  private orderedConfig(): AcpSessionConfigSelection[] {
    const priority = new Map([
      ["model", 0],
      ["mode", 1],
      ["thought_level", 2],
      ["model_config", 3],
    ]);
    return [...(this.input.session_config ?? [])].sort((left, right) =>
      (priority.get(left.category ?? "") ?? 4) - (priority.get(right.category ?? "") ?? 4));
  }

  private sendNextConfig(send: Send, closeStdin: () => void): boolean {
    const selection = this.orderedConfig()[this.configIndex];
    if (!selection) return false;
    const option = this.advertisedConfigOptions.find((candidate) => candidate.id === selection.id);
    if (!option || option.type !== selection.type || option.category !== selection.category) {
      this.fail(`${this.label()} ACP did not advertise session option '${selection.id}'`, closeStdin);
      return true;
    }
    if (selection.type === "select" && !configChoiceValues(option).includes(selection.value as string)) {
      this.fail(
        `${this.label()} ACP did not advertise value '${String(selection.value)}' for session option '${selection.id}'`,
        closeStdin,
      );
      return true;
    }
    if (selection.type === "boolean" && typeof selection.value !== "boolean") {
      this.fail(`${this.label()} ACP received an invalid boolean for session option '${selection.id}'`, closeStdin);
      return true;
    }
    if (option.currentValue === selection.value) {
      if (selection.category === "model" && !this.input.attributed_model) {
        this.selectedModel = String(selection.value);
      }
      this.configIndex += 1;
      return this.sendNextConfig(send, closeStdin);
    }
    this.phase = "set_config";
    this.activeConfigRequestId = 3 + this.configIndex / 100;
    send({
      jsonrpc: "2.0",
      id: this.activeConfigRequestId,
      method: "session/set_config_option",
      params: { sessionId: this.sessionId, configId: selection.id, value: selection.value },
    });
    return true;
  }

  private prompt(send: Send): void {
    send({
      jsonrpc: "2.0",
      id: 4 + this.promptIndex,
      method: "session/prompt",
      params: {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: this.input.prompts[this.promptIndex]! }],
      },
    });
  }

  private fail(message: string, closeStdin: () => void): void {
    this.error = message;
    closeStdin();
  }

  private approvePermissionRequest(
    message: Record<string, unknown> & { id: string | number; method: string },
    send: Send,
    closeStdin: () => void,
  ): void {
    const params = record(message.params);
    const requestSessionId = stringField(params, "sessionId");
    if (!this.sessionId || !requestSessionId || requestSessionId !== this.sessionId) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32600, message: "Permission requested for an out-of-scope session" },
      });
      this.fail(`${this.label()} ACP requested permission for an out-of-scope session`, closeStdin);
      return;
    }
    // Cast against the SDK's own `PermissionOption` schema type rather than
    // trusting the wire shape by convention — `optionId`/`kind` still go
    // through the same defensive `stringField` extraction as every other
    // field on this generically-typed message, so a malformed entry behaves
    // exactly as before, just checked against an authoritative shape.
    const rawOptions = Array.isArray(params.options) ? (params.options as PermissionOption[]) : [];
    const decision = decidePermission(rawOptions.map((option) => ({
      option_id: stringField(record(option), "optionId"),
      kind: stringField(record(option), "kind"),
    })));
    const toolKind = stringField(record(params.toolCall), "kind");
    this.input.on_permission_decision?.({
      tool_kind: toolKind,
      decision: decision.outcome,
      preauthorized_by: decision.preauthorized_by,
    });
    if (decision.outcome.outcome === "cancelled") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "cancelled" } },
      });
      this.fail(`${this.label()} ACP requested permission with no allow option offered`, closeStdin);
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { outcome: { outcome: "selected", optionId: decision.outcome.option_id } },
    });
  }

  private label(): string {
    return getRuntimeAdapterSpec(this.input.adapter_type)?.display_name ?? this.input.adapter_type;
  }

  private captureSelectedModel(result: Record<string, unknown>): void {
    // A caller that already knows the model has the better answer, and this
    // must not overwrite it: the runtime's echo is an alias on a fresh session
    // and the *previous* turn's model on a resumed one, while the server
    // decided the real one when it wrote the environment.
    if (this.input.attributed_model) return;
    const options = Array.isArray(result.configOptions) ? result.configOptions.map(record) : [];
    const modelOption = options.find((option) => option.category === "model");
    this.selectedModel = stringField(modelOption ?? {}, "currentValue");
  }

  private captureConfigOptions(result: Record<string, unknown>): void {
    if (Array.isArray(result.configOptions)) {
      this.advertisedConfigOptions = result.configOptions.map(record);
      this.captureSelectedModel(result);
    }
  }

  private captureSubscriptionQuota(
    params: Record<string, unknown>,
    update: Record<string, unknown>,
  ): void {
    if (this.input.adapter_type !== "claude_code" || update.sessionUpdate !== "usage_update") return;
    const updateMeta = record(update._meta);
    const paramsMeta = record(params._meta);
    const claudeMeta = record(
      updateMeta["_claude/rateLimit"]
        ?? paramsMeta["_claude/rateLimit"]
        ?? record(updateMeta._claude).rateLimit
        ?? record(paramsMeta._claude).rateLimit,
    );
    const status = stringField(claudeMeta, "status");
    const rateLimitType = stringField(claudeMeta, "rateLimitType");
    const utilization = finiteNumber(claudeMeta.utilization);
    const resetsAt = nonNegativeInteger(claudeMeta.resetsAt);
    if (
      !status
      || !rateLimitType
      || utilization === null
      || utilization < 0
      || utilization > 1
      || resetsAt === null
      || typeof claudeMeta.isUsingOverage !== "boolean"
    ) return;
    this.subscriptionQuota = {
      status,
      rate_limit_type: rateLimitType,
      utilization,
      resets_at: resetsAt,
      is_using_overage: claudeMeta.isUsingOverage,
    };
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

function configChoiceValues(option: Record<string, unknown>): string[] {
  if (!Array.isArray(option.options)) return [];
  return option.options.flatMap((entry) => {
    const candidate = record(entry);
    if (Array.isArray(candidate.options)) {
      return candidate.options.map(record).map((choice) => stringField(choice, "value")).filter(isString);
    }
    const value = stringField(candidate, "value");
    return value ? [value] : [];
  });
}

function isString(value: string | null): value is string {
  return value !== null;
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

function addUsage(
  current: CanonicalUsage | null,
  next: CanonicalUsage | null,
): CanonicalUsage | null {
  if (!current) return next;
  if (!next) return current;
  const result: CanonicalUsage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "reasoning_tokens",
  ] as const) {
    const left = current[key];
    const right = next[key];
    if (left !== undefined || right !== undefined) result[key] = (left ?? 0) + (right ?? 0);
  }
  return result;
}

function addModelUsage(
  current: CanonicalModelUsage[],
  model: string,
  usage: CanonicalUsage,
): CanonicalModelUsage[] {
  const existing = current.find((item) => item.model === model);
  if (!existing) return [...current, { model, usage }];
  return current.map((item) => item.model === model
    ? { model, usage: addUsage(item.usage, usage)! }
    : item);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
