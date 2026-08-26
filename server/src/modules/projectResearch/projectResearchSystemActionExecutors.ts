import type { SystemActionId } from "@agent-space/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";
import { PgAgentGroupRepository } from "../agentGroups/repository.js";
import { ResearchAcquisitionService } from "./pipeline/researchAcquisitionService.js";
import { ResearchOperationCancelService } from "./researchOperationCancel.js";

/**
 * `research.start_acquisition` (action authority consolidation plan, P1.3;
 * originally room-advancement-reliability-plan Phase 4): unlike a generic
 * proposal executor, this is direct-execution, so the executor calls
 * `ResearchAcquisitionService` rather than a proposal service. Room origin
 * is resolved from the Run's own agent-group membership — the same lookup
 * `AgentGroupRunLifecycleProjector` uses for delegation-completion
 * notifications — not carried by the tool call itself, matching how
 * `agent.delegate` never asks the model for room context either.
 */
export function registerProjectResearchSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("research.start_acquisition" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("research.start_acquisition requires a project-scoped run");
    const body = input as { thread_id: string; intent_note?: string };
    const origin = run.run_group_id ? await new PgAgentGroupRepository(db).getGroup(run.space_id, run.run_group_id) : null;
    const result = await new ResearchAcquisitionService(db).startAcquisition(identity, run.project_id, {
      threadId: body.thread_id,
      intentNote: body.intent_note ?? null,
      originRoomId: origin?.room_id ?? null,
      originSessionId: origin?.session_id ?? null,
    });
    return {
      modelResult: { ok: true, tool: "research.start_acquisition", ...result },
      summary: { tool_name: "research.start_acquisition", ok: true, ...result },
    };
  });

  executors.set("research.cancel_acquisition" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("research.cancel_acquisition requires a project-scoped run");
    const body = input as { operation_id: string; reason?: string };
    const result = await new ResearchOperationCancelService(db).cancelOperation(
      identity,
      run.project_id,
      body.operation_id,
      body.reason ?? null,
    );
    return {
      modelResult: { ok: true, tool: "research.cancel_acquisition", ...result },
      summary: { tool_name: "research.cancel_acquisition", ok: true, ...result },
    };
  });
}
