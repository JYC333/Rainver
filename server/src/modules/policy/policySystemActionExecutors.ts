import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { AgentRunRecord } from "../runs/repository.js";
import { AuthorizationRequestService } from "./authorizationRequestService.js";

/** `authorization.request` (action authority consolidation plan, P1.5). */
export function registerPolicySystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: AgentRunRecord,
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
    };
  });
}
