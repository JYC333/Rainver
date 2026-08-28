import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import {
  isChineseTitle,
  type ConversationContinuationRegistry,
} from "../proposals/continuationRegistry.js";
import { HttpError } from "../routeUtils/common.js";
import { ProjectKernelService } from "./kernelService.js";

/** Publishes a new immutable Project Brief under the accepting owner's identity. */
export function registerProjectDefinitionProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("project_brief_publish", async (context: ProposalApplyContext): Promise<ProposalApplyResult> => {
    const { db, proposal, userId } = context;
    if (!proposal.project_id) throw new HttpError(422, "project_brief_publish proposal is missing project_id");
    const {
      proposal_type: _proposalType,
      action_id: _actionId,
      project_id: _projectId,
      ...briefBody
    } = proposal.payload_json ?? {};
    const kernel = new ProjectKernelService(db);
    const identity = { spaceId: proposal.space_id, userId };
    const draft = await kernel.createBriefVersion(identity, proposal.project_id, briefBody);
    const briefId = (draft as { id?: string }).id;
    if (!briefId) throw new HttpError(500, "Project Brief draft did not return an id");
    await kernel.submitBriefForReview(identity, proposal.project_id, briefId);
    const published = await kernel.publishBrief(identity, proposal.project_id, briefId);
    return {
      result_type: "project_brief_version",
      result: { project_brief_version_id: (published as { id?: string }).id },
    };
  });
}

/**
 * Continuation for an accepted `project_brief_publish`: unlike
 * the retired thread proposal, this is a genuinely single-tool case — the
 * only next step is decomposing the Brief into Inquiry Threads via
 * `inquiry.create_thread`, so the directive names that tool directly.
 */
export function registerProjectDefinitionContinuation(registry: ConversationContinuationRegistry): void {
  registry.register("project_brief_publish", ({ proposal }) => {
    const chinese = isChineseTitle(proposal.proposed_title || "the proposal");
    const instruction = chinese
      ? "用户已确认上一项项目定义。现在直接将它拆成 3–5 个关键研究问题，并逐个创建到项目的问题列表。拆出几个，就必须实际执行几次创建动作；不要只在回复里列清单。这些问题会立即存在，不要再逐个征求确认——用户在项目动态里看得到，也可以随时归档。完成后用一句话说明实际创建了几个；任何一个失败都要明确说明。"
      : "The user accepted the preceding Project definition. Now decompose it into 3–5 key research questions and create each one in the Project question list. If you identify N questions, execute the creation action N times; do not merely list them in the reply. They exist immediately — do not ask the user to confirm each one; they see every question you open in the Project's updates and can archive any of them. Finish with one sentence stating exactly how many were created, and clearly report any failure.";
    return { directive: "inquiry.create_thread", instruction };
  });
}
