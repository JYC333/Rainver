import type { RuntimeHostExecuteResponse, SystemActionId } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { SystemActionExecutor } from "../systemActions/gateway";
import type { RunRecord } from "../runs/repository";
import { AuthorizationRequestService } from "./authorizationRequestService";

/** `authorization.request` (action authority consolidation plan, P1.5). */
export function registerPolicySystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);

  executors.set("authorization.request" as SystemActionId, async (input) => {
    const body = input as { policy_decision_record_id: string; reason: string };
    const request = await new AuthorizationRequestService(db, config).createFromDeniedDecision({
      spaceId: run.space_id,
      runId: run.id,
      agentId: run.agent_id,
      policyDecisionRecordId: body.policy_decision_record_id,
      reason: body.reason,
    });
    return {
      modelResult: { ok: true, authorization_request: request },
      summary: {
        tool_name: "authorization.request",
        ok: true,
        authorization_request_id: request.id,
        status: request.status,
      },
      suspend: authorizationRequestPauseResponse(request.id),
    };
  });
}

function authorizationRequestPauseResponse(requestId: string): RuntimeHostExecuteResponse {
  return {
    success: false,
    stdout: "",
    stderr: "",
    output_text: "",
    output_json: {
      authorization_request_id: requestId,
      authorization_request_status: "pending",
    },
    exit_code: null,
    error_text: "Agent authorization request is pending review.",
    error_code: "authorization_request_pending",
    started_at: null,
    completed_at: new Date().toISOString(),
    model: null,
    usage: null,
    events: [],
    adapter_metadata: {},
    adapter_log_json: null,
  };
}
