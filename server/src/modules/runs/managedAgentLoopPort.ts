/**
 * The agent-space contract for a managed multi-turn tool loop.
 *
 * A managed run that carries tool grants alternates model turns and tool calls
 * until the model stops asking, a tool suspends the run, the caller aborts, or
 * the turn budget is spent. That alternation is the only thing this port
 * describes. Every authority around it stays outside: the model call goes back
 * through `executeModel`, which is the ordinary Runtime Host executor and
 * therefore produces a fresh accepted Delivery, dispatch fingerprint and usage
 * record per turn; `dispatch` reaches `SystemActionGateway`, which remains the
 * validation, grant, policy and audit boundary. An implementation of this port
 * conducts; it owns no provider, credential, policy, database or context.
 *
 * This module must not import an implementation, and must not import a vendor
 * agent-loop package. `boundaries.test.ts` enforces both, because the reason
 * the port exists is that the previous single module made replacing the
 * implementation an edit to the file every caller imported.
 */
import type {
  CanonicalToolCall,
  CanonicalToolDefinition,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@agent-space/protocol";
import type { ServerConfig } from "../../config.js";

/** One physical model turn. Implementations call this once per turn, never directly a provider. */
export type ManagedModelRequest = (
  config: ServerConfig,
  request: RuntimeHostExecuteRequest,
) => Promise<RuntimeHostExecuteResponse>;

export interface ManagedToolDispatchResult {
  modelResult: unknown;
  summary: Record<string, unknown>;
  artifact?: unknown;
  /** Terminates the current batch and becomes the run's response. */
  suspend?: RuntimeHostExecuteResponse;
}

export interface ManagedAgentLoopInput {
  config: ServerConfig;
  request: RuntimeHostExecuteRequest;
  executeModel: ManagedModelRequest;
  tools: CanonicalToolDefinition[];
  toolBindings: RuntimeHostExecuteRequest["tool_bindings"];
  dispatch: (call: CanonicalToolCall) => Promise<ManagedToolDispatchResult>;
  maxTurns: number;
  signal?: AbortSignal;
}

export interface ManagedAgentLoopResult {
  response: RuntimeHostExecuteResponse;
  toolSummaries: Array<Record<string, unknown>>;
  artifacts: unknown[];
  turnLimitReached: boolean;
}

export interface ManagedAgentLoopPort {
  run(input: ManagedAgentLoopInput): Promise<ManagedAgentLoopResult>;
}
