import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../src/config.js";
import { dispatchRunTool, resolveRunToolScope } from "../../src/modules/runs/runToolService.js";

/** Exercise the shared Run tool authority in tests concerned with domain behavior. */
export async function runTool(
  config: ServerConfig, runId: string, token: string, actionId?: string, args?: object, key: string = randomUUID(),
): Promise<{ statusCode: number; body: string; json(): any }> {
  const scope = await resolveRunToolScope(config, runId, token);
  const result = !("run" in scope) ? scope : !actionId
    ? await dispatchRunTool(scope, { kind: "list" })
    : !args ? await dispatchRunTool(scope, { kind: "describe", actionId })
      : await dispatchRunTool(scope, { kind: "call", actionId, idempotencyKey: key, arguments: () => ({ ...args }) });
  const body = JSON.stringify(result.body);
  result.afterReply?.();
  return { statusCode: result.status, body, json: () => JSON.parse(body) };
}
