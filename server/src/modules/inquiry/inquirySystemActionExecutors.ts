import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";
import { runVisibility } from "../runs/runInputEnvelope.js";
import { InquiryThreadProposalService } from "./inquiryThreadProposalService.js";
import { InquiryConclusionProposalService } from "./inquiryConclusionProposalService.js";

/**
 * `inquiry.propose_thread` and `inquiry.record_conclusion` (action authority
 * consolidation plan, P1.3). Both draft a reviewable Proposal; durable
 * mutation happens only through the owning applier after acceptance.
 */
export function registerInquirySystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("inquiry.propose_thread" as SystemActionId, async (input, context) => {
    if (!run.project_id) throw new Error("inquiry.propose_thread requires a project-scoped run");
    const result = await new InquiryThreadProposalService(db).proposeThread(
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
      modelResult: { ok: true, proposal: result.proposal },
      summary: { tool_name: "inquiry.propose_thread", ok: true, proposal_id: (result.proposal as { id?: string }).id },
    };
  });

  executors.set("inquiry.record_conclusion" as SystemActionId, async (input, context) => {
    if (!run.project_id) throw new Error("inquiry.record_conclusion requires a project-scoped run");
    const result = await new InquiryConclusionProposalService(db).proposeConclusion(
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
      modelResult: { ok: true, proposal: result.proposal },
      summary: { tool_name: "inquiry.record_conclusion", ok: true, proposal_id: (result.proposal as { id?: string }).id },
    };
  });
}
