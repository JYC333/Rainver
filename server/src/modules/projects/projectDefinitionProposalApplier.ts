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
 * Continuation for an accepted `project_brief_publish`: one next step, chosen
 * from the goal, taken directly.
 *
 * A Project has no type field (ADR 0019); what the accepted goal asks for is
 * the only signal, and the Agent reads it. A goal that is a question opens
 * one Inquiry Thread; a goal that names something to build or deliver creates
 * the first Task. One, not a batch: the earlier "decompose into 3–5 research
 * questions" gave every Project a research shape and a starting load the
 * person had not asked for. The rest is offered in the reply and created
 * when they say so — the pace is theirs.
 */
export function registerProjectDefinitionContinuation(registry: ConversationContinuationRegistry): void {
  registry.register("project_brief_publish", ({ proposal }) => {
    const chinese = isChineseTitle(proposal.proposed_title || "the proposal");
    const instruction = chinese
      ? "用户已确认上一项项目定义。根据这个目标本身判断第一步是什么，并只做这一步：如果目标是一个要弄清楚的问题，用 inquiry.create_thread 开一个最关键的研究问题；如果目标是要做出或交付某样东西，先用 task.list 确认没有重复，再用 task.create 建第一个任务。只创建一个，不要一次拆出一整套；后续步骤在回复里用一两句话说明，等用户说继续再建。创建的对象会立即存在，不要再征求确认；用一句话说明实际创建了什么，任何失败都要明确说明。"
      : "The user accepted the preceding Project definition. Judge from the goal itself what the first step is, and take only that step: if the goal is a question to be answered, open the single most important research question with inquiry.create_thread; if it names something to build or deliver, call task.list to rule out a duplicate and then create the first Task with task.create. Create one object, not a whole breakdown; mention the following steps in a sentence or two and create them when the user says to continue. What you create exists immediately — do not ask for confirmation; state in one sentence exactly what was created, and clearly report any failure.";
    return { directive: null, instruction };
  });
}
