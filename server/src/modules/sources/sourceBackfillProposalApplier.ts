import type { ProposalApplierRegistry } from "../proposals/applierRegistry.js";
import { requiredString } from "../routeUtils/common.js";
import { SourceBackfillExecutionService } from "./sourceBackfillExecutionService.js";

export function registerSourceBackfillProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("source_backfill_start", async ({ db, proposal }) => {
    const planId = requiredString(proposal.payload_json?.source_backfill_plan_id, "source_backfill_plan_id");
    const result = await new SourceBackfillExecutionService(db).start(
      proposal.space_id,
      planId,
      proposal.id,
      proposal.payload_json?.strategy_json,
      proposal.payload_json?.quota_policy_json,
    );
    return { result_type: "source_backfill_plan", result: { plan_id: planId, dispatch: result } };
  });
}
