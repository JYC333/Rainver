import type { SystemActionId } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { SystemActionExecutor } from "../systemActions/gateway";
import type { RunRecord } from "../runs/repository";
import { PgAgentGroupRepository } from "../agentGroups/repository";
import { ResearchAcquisitionService } from "./pipeline/researchAcquisitionService";

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
}
