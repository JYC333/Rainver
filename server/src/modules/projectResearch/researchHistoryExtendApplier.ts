import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import { HttpError, optionalString } from "../routeUtils/common.js";
import { ProjectResearchOrchestrator } from "./orchestrator.js";

/**
 * Runs the earlier history a bounded acquisition left unread.
 *
 * The first pass is capped and says so; this is the other half of that
 * bargain — the remainder is offered once, as a decision, and only starts if
 * a person takes it. It reuses `startHistoricalBackfill` rather than a second
 * path into the same work: coverage overlap, idempotency, and the Operation
 * it produces are that method's, already.
 */
export function registerResearchHistoryExtendApplier(registry: ProposalApplierRegistry): void {
  registry.register("research_history_extend", async (context: ProposalApplyContext): Promise<ProposalApplyResult> => {
    const { config, db, proposal, userId } = context;
    const payload = proposal.payload_json ?? {};
    const projectId = proposal.project_id ?? optionalString(payload.project_id);
    const workflowId = optionalString(payload.workflow_id);
    const from = optionalString(payload.from);
    const to = optionalString(payload.to);
    if (!projectId || !workflowId || !from || !to) {
      throw new HttpError(422, "research_history_extend proposal is missing its range");
    }
    const started = await new ProjectResearchOrchestrator(db, config).startHistoricalBackfill(
      { spaceId: proposal.space_id, userId },
      projectId,
      workflowId,
      { from, to, max_items: payload.max_items },
    );
    return {
      result_type: "project_operation",
      result: { project_operation_id: (started as { id?: string }).id ?? null },
    };
  });
}
