import type { SystemActionId } from "@agent-space/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";
import { runVisibility } from "../runs/runInputEnvelope.js";
import { KnowledgePromotionCandidateService } from "./candidateService.js";

/**
 * `inquiry.promote_knowledge` (action authority consolidation plan, P1.3).
 * Combines Candidate creation and an immediate promote decision into one
 * call, so a conversational instruction produces one reviewable Proposal.
 */
export function registerKnowledgePromotionSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("inquiry.promote_knowledge" as SystemActionId, async (input, context) => {
    if (!run.project_id) throw new Error("inquiry.promote_knowledge requires a project-scoped run");
    const result = await new KnowledgePromotionCandidateService(db).proposeFromThreadForAgent(
      identity,
      run.project_id,
      input as Record<string, unknown>,
      {
        agentId: run.agent_id,
        runId: run.id,
        idempotencyKey: context.idempotency_key,
        visibility: runVisibility(run.visibility),
      },
    );
    return {
      modelResult: { ok: true, candidate: result.candidate },
      summary: { tool_name: "inquiry.promote_knowledge", ok: true, proposal_id: result.proposal_id },
    };
  });
}
