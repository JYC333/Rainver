import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry";
import { HttpError, requiredString } from "../routeUtils/common";
import { InquiryIterationService } from "./iterationService";

/**
 * Materializes an agent-drafted `inquiry_conclusion` Proposal into an
 * Iteration on accept. Runs under the accepting user's identity
 * (`context.userId`) so `recordIteration`'s `assertProjectWriter` check is a
 * real reviewing user, matching ADR 0003: the agent drafted the payload, the
 * accepting user's own action performs the write.
 */
export function registerInquiryConclusionProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("inquiry_conclusion", async (context: ProposalApplyContext): Promise<ProposalApplyResult> => {
    const { db, proposal, userId } = context;
    if (!proposal.project_id) throw new HttpError(422, "inquiry_conclusion proposal is missing project_id");
    const payload = proposal.payload_json ?? {};
    const threadId = requiredString(payload.thread_id, "thread_id");
    const {
      thread_id: _threadId,
      proposal_type: _proposalType,
      action_id: _actionId,
      ...body
    } = payload;

    const iteration = await new InquiryIterationService(db).recordIteration(
      { spaceId: proposal.space_id, userId },
      proposal.project_id,
      threadId,
      { ...body, trigger_kind: "agent_conclusion", trigger_ref: proposal.id },
    );

    return {
      result_type: "inquiry_iteration",
      result: { thread_id: threadId, iteration_id: (iteration as { id?: string }).id },
    };
  });
}
