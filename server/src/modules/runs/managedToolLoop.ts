/**
 * The generic managed tool loop.
 *
 * Every managed tool family — Retrieval, Agent delegation, and the generic
 * SystemAction transports — reaches the model through here. The loop knows
 * nothing about any of them: it takes an assembled `ManagedToolSet`, drives
 * `ManagedAgentLoopPort`, and reports what the tools did. `ManagedAgentToolSurface`
 * owns the assembly, driving `SystemActionDispatcher` for exposure and dispatch.
 *
 * This module must not import anything from `retrieval`. The loop used to live
 * inside the Retrieval domain, which meant a run carrying only delegation or a
 * proposal action had to fabricate an empty retrieval binding to reach it, and
 * every tool summary it produced was filed as a retrieval call.
 */
import type {
  CanonicalMessage,
  CanonicalToolCall,
  CanonicalToolDefinition,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { managedAgentLoop } from "./managedAgentLoopBinding.js";
import type { ManagedModelRequest, ManagedToolDispatchResult } from "./managedAgentLoopPort.js";

/**
 * Four *model* turns. Deliberately unchanged while moving out of Retrieval,
 * where it was a module constant: raising it multiplies a run's worst-case
 * provider calls, and the Run retry cost cap and autonomy daily limit have not
 * been calibrated against real catalog spend. It is a parameter here so that
 * decision can be taken on evidence rather than during a refactor.
 */
export const DEFAULT_MAX_MODEL_TURNS = 4;

/**
 * What one tool family offers a run. A family with nothing to offer contributes
 * nothing; that absence is the whole representation of the fact, and needs no
 * placeholder object.
 */
export interface ManagedToolContribution {
  definitions: CanonicalToolDefinition[];
  bindings: RuntimeHostExecuteRequest["tool_bindings"];
  /**
   * Model-visible content the family produced before the first turn — a
   * retrieval preflight result is the only current case — together with the
   * summaries and artifacts that producing it generated.
   */
  prefaceMessages?: CanonicalMessage[];
  prefaceSummaries?: Array<Record<string, unknown>>;
  prefaceArtifacts?: unknown[];
}

export type ManagedToolDispatch = (call: CanonicalToolCall) => Promise<ManagedToolDispatchResult>;

export interface ManagedToolSet {
  definitions: CanonicalToolDefinition[];
  bindings: RuntimeHostExecuteRequest["tool_bindings"];
  dispatch: ManagedToolDispatch;
  prefaceMessages: CanonicalMessage[];
  prefaceSummaries: Array<Record<string, unknown>>;
  prefaceArtifacts: unknown[];
  maxModelTurns: number;
}

export function mergeManagedToolContributions(
  contributions: readonly (ManagedToolContribution | null)[],
  dispatch: ManagedToolDispatch,
  maxModelTurns: number = DEFAULT_MAX_MODEL_TURNS,
): ManagedToolSet {
  const present = contributions.filter((value): value is ManagedToolContribution => value !== null);
  return {
    definitions: present.flatMap((contribution) => contribution.definitions),
    bindings: present.flatMap((contribution) => contribution.bindings),
    dispatch,
    prefaceMessages: present.flatMap((contribution) => contribution.prefaceMessages ?? []),
    prefaceSummaries: present.flatMap((contribution) => contribution.prefaceSummaries ?? []),
    prefaceArtifacts: present.flatMap((contribution) => contribution.prefaceArtifacts ?? []),
    maxModelTurns,
  };
}

export async function executeManagedToolLoop(
  config: ServerConfig,
  request: RuntimeHostExecuteRequest,
  execute: ManagedModelRequest,
  toolSet: ManagedToolSet,
  options: { signal?: AbortSignal } = {},
): Promise<RuntimeHostExecuteResponse> {
  // A tool set with no tools is a single bounded call, which is what a
  // preflight-only run has always been.
  if (toolSet.definitions.length === 0) {
    // Offering no tools is stated on the request rather than inherited from the
    // caller. Every current entrypoint already sends `disabled`, so this changes
    // no behaviour; it makes the property belong to the loop, so a future
    // caller or a family that contributes zero definitions cannot leave an
    // empty `authorized_bindings` request to trip `runtime_tool_provider_unsupported`.
    const response = await execute(config, {
      ...request,
      ...(toolSet.prefaceMessages.length
        ? { messages: [...initialMessagesForToolLoop(request), ...toolSet.prefaceMessages] }
        : {}),
      tool_mode: "disabled",
      tool_bindings: [],
    });
    return responseWithManagedToolMetadata(response, toolSet.prefaceSummaries, toolSet.prefaceArtifacts);
  }

  const loop = await managedAgentLoop.run({
    config,
    request: {
      ...request,
      messages: [...initialMessagesForToolLoop(request), ...toolSet.prefaceMessages],
    },
    executeModel: execute,
    tools: toolSet.definitions,
    toolBindings: toolSet.bindings,
    dispatch: toolSet.dispatch,
    maxTurns: toolSet.maxModelTurns,
    signal: options.signal,
  });

  const summaries = [...toolSet.prefaceSummaries, ...loop.toolSummaries];
  return responseWithManagedToolMetadata(
    loop.turnLimitReached ? withoutPendingToolCalls(loop.response) : loop.response,
    loop.turnLimitReached
      ? [...summaries, turnLimitSummary(loop.toolSummaries, toolSet.definitions)]
      : summaries,
    [...toolSet.prefaceArtifacts, ...loop.artifacts],
  );
}

/**
 * Name the tool that actually spent the budget rather than the family that
 * used to own the loop, so a delegation run that runs out of turns does not
 * report a retrieval failure.
 */
function turnLimitSummary(
  loopSummaries: readonly Record<string, unknown>[],
  definitions: readonly CanonicalToolDefinition[],
): Record<string, unknown> {
  const lastCalled = [...loopSummaries].reverse().find((summary) => typeof summary.tool_name === "string");
  // When the budget ran out on text-only turns no tool spent it, so naming the
  // first *offered* definition would invent an attribution — and would name a
  // family, which is the misattribution this vocabulary move removed. Fall back
  // to the same neutral id the provider-unsupported summary uses.
  const toolName = lastCalled?.tool_name ?? "managed_tools";
  return { tool_name: toolName, ok: false, error_code: "managed_tool_turn_limit" };
}

function responseWithManagedToolMetadata(
  response: RuntimeHostExecuteResponse,
  toolSummaries: Array<Record<string, unknown>>,
  artifacts: unknown[],
): RuntimeHostExecuteResponse {
  if (toolSummaries.length === 0 && artifacts.length === 0) return response;
  const output = {
    ...recordOrEmpty(response.output_json),
    ...(toolSummaries.length ? { managed_tool_calls: toolSummaries } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  };
  const metadata = {
    ...recordOrEmpty(response.adapter_metadata),
    managed_tool_calls: toolSummaries.map((summary) => ({
      tool_name: summary.tool_name,
      ok: summary.ok,
      result_count: summary.result_count ?? null,
      synthesized: summary.synthesized ?? null,
      error_code: summary.error_code ?? null,
    })),
  };
  return { ...response, output_json: output, adapter_metadata: metadata };
}

function initialMessagesForToolLoop(request: RuntimeHostExecuteRequest): CanonicalMessage[] {
  if (request.messages?.length) return request.messages.map((message) => ({ ...message }));
  return [{ role: "user", content: request.prompt }];
}

function withoutPendingToolCalls(response: RuntimeHostExecuteResponse): RuntimeHostExecuteResponse {
  const output = recordOrEmpty(response.output_json);
  if (!("tool_calls" in output)) return response;
  const { tool_calls: _dropped, ...rest } = output;
  return { ...response, output_json: rest };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
