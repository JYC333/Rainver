import type {
  CanonicalMessage,
  CanonicalUsage,
  RunAdapterResultEnvelope,
  RunInputEnvelope,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
  RunTriggerOrigin,
  InvocationDelivery,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import {
  authorizeRuntimeHostDelivery,
  bindRuntimeHostDeliveryRequest,
  executeRuntimeHost,
  type RuntimeHostLogger,
} from "../runtimeHost/index.js";
import { getDbPool } from "../../db/pool.js";
import { contractRecord } from "./contractSnapshot.js";
import { assembleRunInputEnvelope } from "./runInputEnvelope.js";
import type { RunRecord } from "./repository.js";
import type { ManagedApiRetrievalToolDeps } from "./managedRetrievalTools.js";
import type { AgentDelegationToolDeps } from "./managedAgentDelegationTools.js";
import { ManagedAgentToolSurface } from "../systemActions/managedAgentToolSurface.js";
import {
  redactEvidenceText,
  redactSecretPatterns,
  sanitizeEvidenceJson,
} from "./evidenceRedaction.js";
import { normalizeManagedModelEvents } from "./runtimeEventNormalization.js";
import { managedAdapterRequest } from "../runtimeContext/index.js";
import type { RunInvocationAttemptLifecycle } from "./runtimeContextAttempts.js";

export type ManagedApiAdapterType = "model_api" | "ts_agent_host";

// NOTE: runtime.execute / runtime.use_credential policy is enforced once,
// upstream, in RunOrchestrationService.enforceRuntimePolicy. This adapter is
// only reached after that gate allows the run, so it holds no policy seam of
// its own.

export type RuntimeHostExecutor = (
  config: ServerConfig,
  request: RuntimeHostExecuteRequest,
  options?: { signal?: AbortSignal },
) => Promise<RuntimeHostExecuteResponse>;

export interface ManagedApiNoToolAdapterInput {
  run: RunRecord;
  run_input?: RunInputEnvelope;
  model?: string | null;
  system_prompt?: string | null;
  prompt?: string | null;
  context_text?: string | null;
  max_tokens?: number | null;
  text_delta_sink?: (delta: string) => void;
  abort_signal?: AbortSignal;
  invocation_delivery?: InvocationDelivery;
  invocation_attempts?: RunInvocationAttemptLifecycle;
}

export interface ManagedApiNoToolAdapterDeps extends ManagedApiRetrievalToolDeps {
  executeRuntimeHost?: RuntimeHostExecutor;
  runtimeHostLogger?: RuntimeHostLogger;
  agentDelegationTools?: AgentDelegationToolDeps;
}

export async function executeManagedApiNoToolAdapter(
  config: ServerConfig,
  input: ManagedApiNoToolAdapterInput,
  deps: ManagedApiNoToolAdapterDeps = {},
): Promise<RunAdapterResultEnvelope> {
  const startedAt = new Date().toISOString();
  const adapterType = normalizeManagedApiAdapterType(
    input.run.adapter_type,
  );
  if (!adapterType) {
    return failureEnvelope(
      input,
      "managed_api_adapter_unsupported",
      `Managed API no-tool execution does not support adapter '${input.run.adapter_type ?? "unknown"}'.`,
      startedAt,
    );
  }

  const modelProviderId = input.run.model_provider_id;
  if (!modelProviderId) {
    return failureEnvelope(
      input,
      "model_provider_required",
      `${adapterType} adapter requires an explicit ModelProvider grant.`,
      startedAt,
      adapterType,
    );
  }

  const accepted = input.invocation_delivery
    ? await managedAdapterRequest(input.invocation_delivery)
    : null;
  const request = runtimeHostRequest(input, adapterType, modelProviderId, accepted);
  const baseExecute = deps.executeRuntimeHost
    ?? (async (runtimeConfig, runtimeRequest, options) => {
      if (runtimeRequest.invocation_audit_refs) {
        if (!runtimeConfig.databaseUrl) throw new Error("SERVER_DATABASE_URL is required for Runtime Host dispatch");
        const db = getDbPool(runtimeConfig.databaseUrl);
        await bindRuntimeHostDeliveryRequest(db, runtimeRequest);
        await authorizeRuntimeHostDelivery(db, runtimeRequest);
      } else {
        throw new Error("Managed Runtime Host dispatch requires Invocation Delivery audit references");
      }
      return executeRuntimeHost(
        runtimeConfig,
        runtimeRequest,
        deps.runtimeHostLogger,
        { onTextDelta: input.text_delta_sink, signal: options?.signal },
      );
    });
  let firstDelivery = input.invocation_delivery ?? null;
  const baseMessageCount = accepted?.messages.length ?? 0;
  const execute = async (runtimeConfig: ServerConfig, runtimeRequest: RuntimeHostExecuteRequest) => {
    const delivery = firstDelivery ?? await input.invocation_attempts?.prepare() ?? null;
    firstDelivery = null;
    const mapped = delivery ? await managedAdapterRequest(delivery) : null;
    const nextRequest = mapped
      ? {
          ...runtimeRequest,
          model_provider_id: mapped.providerId ?? runtimeRequest.model_provider_id,
          model: mapped.model,
          system_prompt: mapped.system,
          prompt: mapped.messages.at(-1)?.content ?? "",
          messages: [
            ...mapped.messages,
            ...(runtimeRequest.messages ?? []).slice(baseMessageCount),
          ],
          invocation_audit_refs: mapped.auditRefs,
        }
      : runtimeRequest;
    let response: RuntimeHostExecuteResponse;
    try {
      response = await baseExecute(runtimeConfig, nextRequest, { signal: input.abort_signal });
    } catch (error) {
      if (delivery && input.invocation_attempts) {
        await input.invocation_attempts.acknowledge(delivery, {
          success: false,
          error_code: "runtime_host_transport_failed",
        });
        await input.invocation_attempts.finalize(delivery, "runtime_host_transport_failed");
      }
      throw error;
    }
    if (delivery && input.invocation_attempts) {
      await input.invocation_attempts.acknowledge(delivery, response);
      await input.invocation_attempts.finalize(delivery, response.error_code ?? null);
    }
    return response;
  };
  const response = await new ManagedAgentToolSurface(config).execute(input.run, request, execute, {
    ...deps,
    abortSignal: input.abort_signal,
  });
  return envelopeFromRuntimeHost(input, adapterType, response, startedAt);
}

function normalizeManagedApiAdapterType(value: string | null | undefined): ManagedApiAdapterType | null {
  if (value === "model_api" || value === "ts_agent_host") return value;
  return null;
}

function runtimeHostRequest(
  input: ManagedApiNoToolAdapterInput,
  adapterType: ManagedApiAdapterType,
  modelProviderId: string,
  accepted: Awaited<ReturnType<typeof managedAdapterRequest>> | null,
): RuntimeHostExecuteRequest {
  // `instruction` is per-run domain content (e.g. the grounding text a
  // capability builds for this specific call), distinct from the agent's
  // persona `system_prompt`. It must always reach the model, not just when
  // no persona is configured — folding it only into `systemPrompt` here
  // meant any agent with a configured persona (the common case) silently
  // dropped it entirely. Route it through the context slot instead, where
  // it composes alongside the persona rather than being shadowed by it.
  const systemPrompt = input.system_prompt ?? input.run.system_prompt ?? null;
  const groupedAgentIdentity = groupedAgentIdentityContext(input.run);
  const override = recordOrEmpty(input.run.model_override_json);
  const messages = canonicalMessages(override.messages);
  const chatContextPreamble = typeof override.chat_context_preamble === "string"
    ? override.chat_context_preamble
    : null;
  const dynamicConversationContext = messages
    ? [
        input.context_text ?? input.run.instruction ?? null,
        chatContextPreamble,
      ].filter((part): part is string => Boolean(part?.trim())).join("\n\n")
    : null;
  const contract = contractRecord(input.run.contract_snapshot_json);
  const outputFormat = structuredOutputFormat(contract.structured_output_json);
  return {
    run_input: input.run_input ?? assembleRunInputEnvelope(input.run, {
      prompt: input.prompt,
    }),
    run_id: input.run.id,
    space_id: input.run.space_id,
    subject_user_id: input.run.instructed_by_user_id ?? input.run.owner_user_id ?? null,
    model_provider_id: modelProviderId,
    // Routing persists the selected model on the run. Worker requests do not
    // repeat that value, so the adapter must honor the durable binding instead
    // of silently falling back to the provider default.
    model: accepted?.model ?? input.model ?? stringValue(override.model),
    system_prompt: accepted?.system ?? composeSystemContext(
      groupedAgentIdentity,
      systemPrompt,
      messages ? null : input.context_text ?? input.run.instruction ?? null,
      messages ? null : chatContextPreamble,
    ),
    prompt: accepted?.messages.at(-1)?.content ?? input.prompt ?? input.run.prompt ?? "",
    ...(accepted
      ? { messages: accepted.messages }
      : messages
      ? { messages: appendDynamicConversationContext(messages, dynamicConversationContext) }
      : {}),
    mode: input.run.mode,
    instruction: input.run.instruction,
    session_id: input.run.session_id,
    parent_run_id: input.run.parent_run_id ?? null,
    root_run_id: input.run.root_run_id ?? null,
    run_group_id: input.run.run_group_id ?? null,
    agent_id: input.run.agent_id,
    project_id: input.run.project_id,
    project_folder_id: input.run.project_folder_id,
    trigger_origin: (input.run.trigger_origin ?? null) as RunTriggerOrigin | null,
    capability_id: null,
    ...(accepted ? { invocation_audit_refs: accepted.auditRefs } : {}),
    max_tokens: accepted?.maxOutputTokens ?? input.max_tokens ?? undefined,
    ...(outputFormat ? { output_format: outputFormat } : {}),
    tool_mode: "disabled",
    tool_bindings: [],
    cache_strategy:
      recordOrEmpty(recordOrEmpty(input.run.model_override_json).chat_turn).schema_version === "chat_turn.v1"
        ? "conversation"
        : undefined,
  };
}

function appendDynamicConversationContext(
  messages: CanonicalMessage[],
  context: string | null,
): CanonicalMessage[] {
  if (!context) return messages;
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) {
    return [...messages, { role: "user", content: context }];
  }
  return messages.map((message, index) =>
    index === lastUserIndex
      ? {
          ...message,
          content: `${message.content ?? ""}\n\n[Retrieved context for this turn]\n${context}`,
        }
      : message);
}

function structuredOutputFormat(value: unknown): RuntimeHostExecuteRequest["output_format"] {
  const record = recordOrEmpty(value);
  const schema = record.schema;
  if (
    record.type !== "json_schema" ||
    typeof record.schema_id !== "string" ||
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) return null;
  return {
    type: "json_schema",
    schema_id: record.schema_id,
    schema: schema as Record<string, unknown>,
    strict: record.strict !== false,
    stage: typeof record.stage === "string" ? record.stage : structuredOutputStage(record.schema_id),
  };
}

function structuredOutputStage(schemaId: string): string {
  if (schemaId === "source_post_processing.result.v1") return "source_post_processing";
  if (schemaId === "project_research.synthesis.v1") return "synthesis";
  return "managed_api";
}

function groupedAgentIdentityContext(run: RunRecord): string | null {
  if (!run.run_group_id) return null;
  const name = stringValue(run.agent_name);
  const label = name ?? "the current room agent";
  return [
    "Agent room execution context:",
    `- You are ${label} for this run.`,
    "- If the user message includes a structured @mention matching your name, treat it as addressing you directly.",
    "- Do not claim to be the room manager or another room member unless this run's agent identity is that agent.",
    "- Internal agent IDs, run IDs, UUIDs, and tool identifiers are system details. Do not include them in user-facing replies unless the user explicitly asks for audit/debug identifiers.",
  ].join("\n");
}

function composeSystemContext(
  systemPrompt: string | null | undefined,
  ...contextParts: Array<string | null | undefined>
): string {
  return [systemPrompt, ...contextParts]
    .map((part) => typeof part === "string" ? part.trim() : "")
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function canonicalMessages(value: unknown): CanonicalMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const messages: CanonicalMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.role !== "string" || record.role.trim().length === 0) {
      return null;
    }
    if (record.content !== null && typeof record.content !== "string") {
      return null;
    }
    messages.push({
      role: record.role,
      content: record.content ?? "",
    });
  }
  return messages;
}

function envelopeFromRuntimeHost(
  input: ManagedApiNoToolAdapterInput,
  adapterType: ManagedApiAdapterType,
  response: RuntimeHostExecuteResponse,
  startedAt: string,
): RunAdapterResultEnvelope {
  const completedAt = response.completed_at ?? new Date().toISOString();
  const actualProviderId =
    stringValue(recordOrEmpty(response.adapter_metadata).model_provider_id) ?? input.run.model_provider_id;
  const requestedProviderId =
    stringValue(recordOrEmpty(response.adapter_metadata).requested_model_provider_id) ?? input.run.model_provider_id;
  const metadata = sanitizeEvidenceJson({
    ...(recordOrEmpty(response.adapter_metadata)),
    adapter_type: adapterType,
    runtime_host_adapter_type: recordOrEmpty(response.adapter_metadata).adapter_type,
    model_provider_id: actualProviderId,
    requested_model_provider_id: requestedProviderId,
    model: response.model ?? input.model ?? null,
  });
  return {
    adapter_type: adapterType,
    adapter_kind: "managed_api",
    success: response.success,
    // Model chat output is consumed downstream as structured data (e.g.
    // source_post_processing's JSON result contract) and is bounded by the
    // request's max_tokens rather than by arbitrary CLI stdout/patch size, so
    // it must not be cut with the fixed evidence-display limit that
    // redactEvidenceText applies — only the secret-pattern redaction applies.
    output_text: redactSecretPatterns(response.output_text || response.stdout || ""),
    output_json: sanitizeEvidenceJson({
      ...(recordOrEmpty(response.output_json)),
      adapter_type: adapterType,
      model: response.model ?? input.model ?? null,
      usage: normalizeUsage(response.usage),
    }) as RunAdapterResultEnvelope["output_json"],
    exit_code: response.exit_code,
    error_code: response.error_code ?? null,
    error_message: redactEvidenceText(response.error_text ?? null),
    started_at: response.started_at ?? startedAt,
    completed_at: completedAt,
    usage: normalizeUsage(response.usage),
    metadata_json: metadata as RunAdapterResultEnvelope["metadata_json"],
    runtime_events: [
      ...normalizeManagedModelEvents(response.events, completedAt),
      ...(actualProviderId && requestedProviderId && actualProviderId !== requestedProviderId
        ? [{
            schema_version: "runtime_event.v1" as const,
            type: "warning" as const,
            occurred_at: completedAt,
            call_id: null,
            summary: "Managed model invocation used a fallback Provider.",
            metadata_json: {
              event_code: "model_provider_mismatch",
              model_provider_id: actualProviderId,
              requested_model_provider_id: requestedProviderId,
            },
          }]
        : []),
    ],
  };
}

function failureEnvelope(
  input: ManagedApiNoToolAdapterInput,
  errorCode: string,
  message: string,
  startedAt: string,
  adapterType: ManagedApiAdapterType = "ts_agent_host",
  metadataJson: unknown = {},
): RunAdapterResultEnvelope {
  const completedAt = new Date().toISOString();
  return {
    adapter_type: adapterType,
    adapter_kind: "managed_api",
    success: false,
    output_text: "",
    output_json: {
      adapter_type: adapterType,
      run_id: input.run.id,
    },
    exit_code: 1,
    error_code: errorCode,
    error_message: redactEvidenceText(message),
    started_at: startedAt,
    completed_at: completedAt,
    usage: null,
    metadata_json: sanitizeEvidenceJson({
      adapter_type: adapterType,
      run_id: input.run.id,
      ...recordOrEmpty(metadataJson),
    }) as RunAdapterResultEnvelope["metadata_json"],
  };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Copies through every token bucket the Runtime Host reported. Buckets carry
 * distinct rates, so dropping one here would make the envelope's cost
 * unrecomputable even though the ledger holds the detail.
 */
function normalizeUsage(value: CanonicalUsage | null | undefined): CanonicalUsage | null {
  if (!value) return null;
  const usage: CanonicalUsage = {};
  const buckets = [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_creation_input_tokens",
    "cache_creation_1h_input_tokens",
    "cache_read_input_tokens",
    "reasoning_tokens",
  ] as const;
  for (const bucket of buckets) {
    if (typeof value[bucket] === "number") usage[bucket] = value[bucket];
  }
  return Object.keys(usage).length > 0 ? usage : null;
}
