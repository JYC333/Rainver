import type { ResearchProviderKey } from "@rainver/protocol";
import type { ProposalApplierRegistry } from "../proposals/applierRegistry.js";
import { requiredString } from "../routeUtils/common.js";
import { ResearchMonitorMaterializer } from "./discovery/monitorMaterializer.js";

export function registerResearchProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("research_query_strategy_activation", async ({ config, db, proposal, userId }) => {
    const candidateStrategyId = requiredString(proposal.payload_json?.candidate_strategy_id, "candidate_strategy_id");
    const plans = await db.query<{ provider_key: string }>(
      `SELECT provider_key FROM research_query_provider_plans
        WHERE strategy_id=$1 AND space_id=$2 AND status='selected'
        ORDER BY provider_key`,
      [candidateStrategyId, proposal.space_id],
    );
    const providerKeys = plans.rows.map((row) => row.provider_key as ResearchProviderKey);
    if (providerKeys.length === 0) throw new Error("Replacement query strategy has no selected provider queries");
    const result = await new ResearchMonitorMaterializer(db, config).materialize(
      { spaceId: proposal.space_id, userId },
      candidateStrategyId,
      {
        providerKeys,
        activationReason: "monitoring_feedback",
        proposalId: proposal.id,
      },
    );
    return {
      result_type: "research_query_strategy",
      result: {
        query_strategy_id: result.query_strategy_id,
        project_id: result.project_id,
        source_count: result.sources.length,
      },
    };
  });
}
