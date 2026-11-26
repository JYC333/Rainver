import type { ServerConfig } from "../../config.js";
import { dbPool } from "../routeUtils/common.js";
import { OperationToolResponse } from "../systemActions/operations/agentResult.js";
import { CliAgentToolTransport } from "./cliToolTransport.js";
import { liveInputChannel } from "./liveInput.js";
import { PgRunRepository, type AgentRunRecord } from "./repository.js";
import { PgRunToolIdentityRepository } from "./runToolIdentityRepository.js";

type RunToolReply = { status: number; body: unknown; afterReply?: () => void };
type RunToolScope = { run: AgentRunRecord; transport: CliAgentToolTransport; launchId: string; startedAt: number };
type RunToolOperation = { kind: "list" } | { kind: "describe"; actionId: string }
  | { kind: "call"; actionId: string; idempotencyKey: string; arguments: () => Record<string, unknown> };

export async function resolveRunToolScope(config: ServerConfig, runId: string, token: string): Promise<RunToolScope | RunToolReply> {
  const startedAt = Date.now();
  const identity = await new PgRunToolIdentityRepository(dbPool(config)).resolve(token, runId);
  if (!identity) return { status: 401, body: { detail: "Invalid or expired Run tool identity" } };
  const run = await PgRunRepository.fromConfig(config).getAgentRun(identity.space_id, runId);
  if (!run || run.space_id !== identity.space_id || run.status !== "running") {
    return { status: 403, body: { detail: "Run tool identity is no longer active" } };
  }
  return { run, transport: new CliAgentToolTransport(config), launchId: identity.launch_id, startedAt };
}

export async function dispatchRunTool(scope: RunToolScope, operation: RunToolOperation, signal?: AbortSignal): Promise<RunToolReply> {
  if (operation.kind === "list") {
    const tools = await scope.transport.list(scope.run);
    return { status: 200, body: {
      run_id: scope.run.id,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    } };
  }
  const { actionId } = operation;
  if (operation.kind === "describe") {
    const tool = (await scope.transport.list(scope.run)).find((entry) => entry.name === actionId);
    if (!tool) {
      return { status: 403, body: { ok: false, error_code: "system_action_not_granted",
        detail: "This action is not available to this Run. Read rainver list; do not guess another name." } };
    }
    return { status: 200, body: {
      name: tool.name, description: tool.description, input_schema: tool.input_schema ?? { type: "object" },
    } };
  }
  const executionChannel = liveInputChannel(scope.run.id);
  try {
    const result = await scope.transport.call(scope.run, {
      id: operation.idempotencyKey, name: actionId, arguments: operation.arguments(),
    }, signal, { launchId: scope.launchId, startedAt: scope.startedAt });
    if (result instanceof OperationToolResponse) return { status: result.httpStatus, body: result.body };
    const receipt = result as { ok?: boolean; status?: string } | null;
    const shouldYield = actionId === "agent.wait_for_results" && receipt?.ok === true && receipt.status === "waiting";
    // The transport delivers the durable receipt before asking the Run to yield.
    return { status: 200, body: result, ...(shouldYield ? { afterReply: () => executionChannel?.yield() } : {}) };
  } catch {
    return { status: 422, body: { ok: false, tool: actionId, error_code: "system_action_failed",
      error: "Run tool call failed. Check the current action list and visible state before deciding the next step." } };
  }
}
