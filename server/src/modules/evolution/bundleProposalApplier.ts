import type {
  ProposalApplyContext,
  ProposalApplierRegistry,
  ProposalApplyResult,
} from "../proposals/applierRegistry.js";
import { applyEvolutionBundleRollback } from "./bundleRepository.js";

interface EvolutionBundleRollbackPayload {
  proposal_type: "evolution_bundle_rollback";
  bundle_id: string;
}

export function registerEvolutionBundleProposalApplier(registry: ProposalApplierRegistry): void {
  registry.register("evolution_bundle_rollback", applyEvolutionBundleRollbackProposal);
}

async function applyEvolutionBundleRollbackProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json as unknown as EvolutionBundleRollbackPayload;
  await applyEvolutionBundleRollback(
    context.db,
    { spaceId: context.proposal.space_id, userId: context.userId },
    payload.bundle_id,
    context.proposal.id,
  );
  return {
    result_type: "evolution_bundle_rollback",
    result: { bundle_id: payload.bundle_id, rollback_proposal_id: context.proposal.id },
  };
}
