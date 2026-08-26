import type { CanonicalToolCall, RuntimeHostExecuteRequest, RuntimeHostExecuteResponse } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import {
  retrievalToolContribution,
  type RuntimeHostExecutor,
} from "../runs/managedRetrievalTools.js";
import {
  executeManagedToolLoop,
  mergeManagedToolContributions,
  type ManagedToolContribution,
} from "../runs/managedToolLoop.js";
import type { RunRecord } from "../runs/repository.js";
import {
  SystemActionDispatcher,
  type SystemActionDispatcherDeps,
} from "./systemActionDispatcher.js";
import {
  DURABLE_ACTION_CLAIM_POLICY,
  PLAIN_STATUS_RESPONSE_POLICY,
} from "./conversationPolicy.js";

export interface ManagedAgentToolSurfaceDeps extends SystemActionDispatcherDeps {
  abortSignal?: AbortSignal;
}

const MANAGED_ACTION_RESPONSE_POLICY = [
  "System action schemas and tool results are internal execution details.",
  "Do not print raw action arguments, JSON schemas, placeholder payloads, or tool-result objects unless the user explicitly asks for JSON.",
  DURABLE_ACTION_CLAIM_POLICY,
  "When the user has clearly confirmed a supported action, call the action instead of simulating it in prose; then summarize the real result in ordinary language.",
  PLAIN_STATUS_RESPONSE_POLICY,
  "If no offered action can perform the request, state that limitation briefly and point to the owning product area.",
].join(" ");

/**
 * Assembles tool definitions/bindings for a managed run and drives the
 * managed model loop. Owns no dispatch or grant logic of its own — that is
 * `SystemActionDispatcher`, which this class constructs and drives.
 */
export class ManagedAgentToolSurface {
  constructor(private readonly config: ServerConfig) {}

  async execute(
    run: RunRecord,
    request: RuntimeHostExecuteRequest,
    execute: RuntimeHostExecutor,
    deps: ManagedAgentToolSurfaceDeps = {},
  ): Promise<RuntimeHostExecuteResponse> {
    const dispatcher = await SystemActionDispatcher.create(this.config, run, request, deps);
    const dispatch = (call: CanonicalToolCall) => dispatcher.dispatch(call);

    // One loop for every managed tool family, assembled from four named
    // contributions. A family with nothing to offer contributes nothing; there
    // is no placeholder carrier, and no family owns the loop on behalf of the
    // others. Retrieval resolves last because a preflight mode performs a
    // governed call through the dispatch built above.
    const contributions: (ManagedToolContribution | null)[] = [
      dispatcher.retrieval
        ? await retrievalToolContribution(dispatcher.retrieval, run, request, request.messages ?? [], dispatch)
        : null,
      dispatcher.delegation
        ? { definitions: dispatcher.delegation.toolDefinitions, bindings: dispatcher.delegation.toolBindings }
        : null,
      dispatcher.genericDefinitions.length
        ? { definitions: dispatcher.genericDefinitions, bindings: dispatcher.genericBindings }
        : null,
      dispatcher.researchDefinitions.length
        ? { definitions: dispatcher.researchDefinitions, bindings: dispatcher.researchBindings }
        : null,
    ];
    return executeManagedToolLoop(
      this.config,
      {
        ...request,
        system_prompt: [request.system_prompt, MANAGED_ACTION_RESPONSE_POLICY]
          .filter((value): value is string => Boolean(value))
          .join("\n\n"),
      },
      execute,
      mergeManagedToolContributions(contributions, dispatch),
      { signal: deps.abortSignal },
    );
  }
}
