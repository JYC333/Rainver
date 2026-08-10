import type {
  CanonicalModelEvent,
  CanonicalUsage,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { resolveProviderCommandStore } from "../providers/commands/store";
import {
  completeProviderMessages,
  ProviderInvocationError,
} from "../providers/invocation/invocation";
import { redactSecretPatterns } from "../runs/evidenceRedaction";

export interface RuntimeHostLogger {
  error(details: Record<string, unknown>, message: string): void;
}

export interface RuntimeHostExecutionHooks {
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

function nowIso(): string {
  return new Date().toISOString();
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function normalizeUsage(raw: Record<string, unknown> | null | undefined): CanonicalUsage | null {
  if (!raw) return null;
  const inputTokens = numberValue(raw.input_tokens ?? raw.prompt_tokens);
  const outputTokens = numberValue(raw.output_tokens ?? raw.completion_tokens);
  const totalTokens = numberValue(raw.total_tokens ?? raw.total_tokens_used ?? raw.total);
  const usage: CanonicalUsage = {};
  if (inputTokens !== undefined) usage.input_tokens = inputTokens;
  if (outputTokens !== undefined) usage.output_tokens = outputTokens;
  if (totalTokens !== undefined) usage.total_tokens = totalTokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

function modelEvents({
  model,
  text,
  usage,
  startedAt,
  toolCalls,
  finishReason,
}: {
  model: string;
  text: string;
  usage: CanonicalUsage | null;
  startedAt: string;
  toolCalls?: Array<{ id: string; name: string; arguments_json: string }>;
  finishReason?: string | null;
}): CanonicalModelEvent[] {
  const events: CanonicalModelEvent[] = [
    { type: "model.message_start", model, occurred_at: startedAt },
  ];
  if (text) events.push({ type: "model.text_delta", delta: text });
  for (const [index, call] of (toolCalls ?? []).entries()) {
    events.push({
      type: "model.tool_call_delta",
      index,
      id: call.id,
      name: call.name,
      arguments_delta: call.arguments_json,
    });
  }
  if (usage) events.push({ type: "model.usage", usage });
  events.push({ type: "model.message_stop", finish_reason: finishReason ?? "stop" });
  return events;
}

function failureResponse(
  input: RuntimeHostExecuteRequest,
  startedAt: string,
  errorCode: string,
  errorText: string,
  diagnostics?: Record<string, unknown>,
  attempts = 1,
): RuntimeHostExecuteResponse {
  const completedAt = nowIso();
  const structuredFailure = input.output_format
    ? `Structured output failed: stage=${input.output_format.stage ?? "managed_api"} schema=${input.output_format.schema_id} provider=${input.model_provider_id} model=${input.model ?? "provider-default"} attempt=${attempts} reason=${errorText}`
    : errorText;
  return {
    success: false,
    stdout: "",
    stderr: structuredFailure,
    output_text: "",
    output_json: {
      adapter_type: "ts_agent_host",
      run_id: input.run_id,
      model_provider_id: input.model_provider_id,
      model: input.model ?? null,
      attempt: attempts,
      ...(input.output_format ? {
        structured_output_schema_id: input.output_format.schema_id,
        structured_output_stage: input.output_format.stage ?? "managed_api",
      } : {}),
      ...(diagnostics ? { structured_output_diagnostics: diagnostics } : {}),
    },
    exit_code: 1,
    error_code: errorCode,
    error_text: structuredFailure,
    started_at: startedAt,
    completed_at: completedAt,
    model: input.model ?? null,
    usage: null,
    events: [
      {
        type: "model.error",
        error: {
          code: errorCode,
          message: structuredFailure,
        },
      },
    ],
    adapter_metadata: {
      adapter_type: "ts_agent_host",
      run_id: input.run_id,
      model_provider_id: input.model_provider_id,
      model: input.model ?? null,
      attempt: attempts,
      ...(input.output_format ? {
        structured_output_schema_id: input.output_format.schema_id,
        structured_output_stage: input.output_format.stage ?? "managed_api",
      } : {}),
      ...(diagnostics ? { structured_output_diagnostics: diagnostics } : {}),
      tool_mode: input.tool_mode,
    },
    adapter_log_json: diagnostics ? { structured_output_diagnostics: diagnostics } : null,
  };
}

export async function executeRuntimeHost(
  config: ServerConfig,
  input: RuntimeHostExecuteRequest,
  logger?: RuntimeHostLogger,
  hooks: RuntimeHostExecutionHooks = {},
): Promise<RuntimeHostExecuteResponse> {
  const startedAt = nowIso();
  const toolMode = input.tool_mode ?? "disabled";
  const toolBindings = input.tool_bindings ?? [];
  const tools = input.tools ?? [];

  if (toolMode !== "disabled" && toolMode !== "authorized_bindings") {
    return failureResponse(
      input,
      startedAt,
      "runtime_tools_not_implemented",
      "server runtime host tool execution is not enabled yet.",
    );
  }
  if (toolMode === "disabled" && (toolBindings.length > 0 || tools.length > 0)) {
    return failureResponse(
      input,
      startedAt,
      "runtime_tools_disabled",
      "Runtime-host tools were provided while tool_mode is disabled.",
    );
  }

  try {
    const result = await completeProviderMessages(
      resolveProviderCommandStore(config),
      input.space_id,
      {
        provider_id: input.model_provider_id,
        model: input.model,
        system: input.system_prompt ?? "",
        messages: input.messages?.length
          ? input.messages.map((message) => ({
              role: message.role,
              content: message.content,
              tool_calls: message.tool_calls,
              tool_call_id: message.tool_call_id,
              name: message.name,
            }))
          : [{ role: "user", content: input.prompt }],
        max_tokens: input.max_tokens,
        output_format: input.output_format ?? null,
        cache_strategy: input.cache_strategy,
        on_text_delta: hooks.onTextDelta,
        abort_signal: hooks.signal,
        allow_provider_fallback: !input.invocation_audit_refs,
        task: "runtime_host",
        tools: toolMode === "authorized_bindings" ? tools : undefined,
        metering: {
          source_type: "local_run",
          execution_channel: "managed_api",
          meter_subject_type: "run",
          meter_subject_id: input.run_id,
          run_id: input.run_id,
          source_resource_type: "run",
          source_resource_id: input.run_id,
          space_system_task: true,
          metadata: input.invocation_audit_refs
            ? { runtime_context_audit_refs: input.invocation_audit_refs }
            : {},
          root_run_id: input.root_run_id ?? null,
          parent_run_id: input.parent_run_id ?? null,
          run_group_id: input.run_group_id ?? null,
          session_id: input.session_id ?? null,
          agent_id: input.agent_id ?? null,
          project_id: input.project_id ?? null,
          project_folder_id: input.project_folder_id ?? null,
          trigger_origin: input.trigger_origin ?? null,
          adapter_type: "ts_agent_host",
          task: "runtime_host",
          dimensions: {
            mode: input.mode,
            tool_mode: toolMode,
            ...(input.invocation_audit_refs
              ? {
                  delivery_id: input.invocation_audit_refs.delivery_id,
                  invocation_snapshot_id: input.invocation_audit_refs.invocation_snapshot_id,
                  execution_control_snapshot_id: input.invocation_audit_refs.execution_control_snapshot_id,
                  usage_source_id: input.invocation_audit_refs.usage_source_id,
                }
              : {}),
          },
        },
      },
    );
    const completedAt = nowIso();
    const usage = normalizeUsage(result.usage);
    const toolCalls = result.tool_calls ?? [];
    return {
      success: true,
      stdout: result.text,
      stderr: "",
      output_text: result.text,
      output_json: result.structured_output ?? {
        adapter_type: "ts_agent_host",
        model: result.model,
        usage,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      exit_code: 0,
      error_code: null,
      error_text: null,
      started_at: startedAt,
      completed_at: completedAt,
      model: result.model,
      usage,
      events: modelEvents({
        model: result.model,
        text: result.text,
        usage,
        startedAt,
        toolCalls,
        finishReason: result.finish_reason,
      }),
      adapter_metadata: {
        adapter_type: "ts_agent_host",
        run_id: input.run_id,
        model_provider_id: result.provider_id,
        requested_model_provider_id: input.model_provider_id,
        model: result.model,
        tool_mode: toolMode,
        tool_count: tools.length,
      },
      adapter_log_json: {
        events_source: "provider_text_completion",
      },
    };
  } catch (error) {
    if (error instanceof ProviderInvocationError) {
      if (error.code === "structured_output_invalid") {
        logger?.error(
          {
            run_id: input.run_id,
            space_id: input.space_id,
            project_id: input.project_id ?? null,
            model_provider_id: input.model_provider_id,
            model: input.model ?? "provider-default",
            stage: input.output_format?.stage ?? "managed_api",
            schema_id: input.output_format?.schema_id ?? null,
            error_code: error.code,
            reason: error.message,
            diagnostics: error.diagnostics ?? null,
            provider_response_text: error.responseText === undefined
              ? null
              : redactSecretPatterns(error.responseText),
          },
          "managed API structured output failed",
        );
      }
      return failureResponse(
        input,
        startedAt,
        // Preserve a specific code (e.g. runtime_tool_provider_unsupported) so the
        // managed-run tool loop can degrade to a no-tool turn instead of failing.
        error.code ?? "provider_invocation_failed",
        error.message,
        error.diagnostics,
        error.attempts ?? 1,
      );
    }
    // Anything that reaches here is not a ProviderInvocationError, so none of
    // the branches above logged it — without this, the only trace of the
    // real failure is the generic message below.
    logger?.error(
      {
        run_id: input.run_id,
        space_id: input.space_id,
        project_id: input.project_id ?? null,
        model_provider_id: input.model_provider_id,
        model: input.model ?? "provider-default",
        stage: input.output_format?.stage ?? "managed_api",
        schema_id: input.output_format?.schema_id ?? null,
        error_name: error instanceof Error ? error.name : typeof error,
        error_message: error instanceof Error ? error.message : String(error),
        error_stack: error instanceof Error ? error.stack : undefined,
      },
      "runtime host call failed with an unclassified error",
    );
    return failureResponse(
      input,
      startedAt,
      "runtime_host_call_failed",
      "server runtime host provider invocation failed.",
    );
  }
}
