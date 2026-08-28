import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import { getDbPool } from "../../db/pool.js";
import { resolveAgentActorId } from "../../db/actorResolver.js";
import { optionalString } from "../routeUtils/common.js";
import { createFollowUpTask, parseFollowUpTaskPayload } from "./followUpTask.js";

/**
 * The follow-up Task a Run asked for, created when the proposal is applied.
 *
 * A person may click Accept, or — after a Run they asked for succeeds —
 * `followUpTaskReconciler.ts` applies it for them
 * ([ADR 0017](../../../../.agent/decisions/0017-authorization-by-cost-not-authorship.md)
 * §2). Both go through here, so what they create cannot drift apart.
 */
async function applyFollowUpTaskProposal(ctx: ProposalApplyContext): Promise<ProposalApplyResult> {
  const fields = parseFollowUpTaskPayload(ctx.proposal.payload_json);
  const task = await createFollowUpTask(
    ctx.db,
    { spaceId: ctx.proposal.space_id, userId: ctx.userId },
    {
      pool: getDbPool(ctx.config.databaseUrl!),
      fields,
      projectId: optionalString(ctx.proposal.project_id ?? null),
      projectFolderId: optionalString(ctx.proposal.project_folder_id),
      // Attributed to the Agent that asked for it, not to whoever accepted:
      // the Task belongs to the person and inherits their access, but on the
      // Board `created_by_user_id` is the person on both routes, so the stream
      // is the only place that can still answer who decided it.
      origin: {
        runId: optionalString(ctx.proposal.created_by_run_id ?? null),
        proposalId: ctx.proposal.id,
        ...(ctx.proposal.created_by_agent_id
          ? {
            agentActorId: await resolveAgentActorId(
              ctx.db,
              ctx.proposal.space_id,
              ctx.proposal.created_by_agent_id,
            ),
          }
          : {}),
      },
      source: "follow_up_task_proposal",
    },
  );
  return { result_type: "follow_up_task", result: { task } };
}

export function registerTaskProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("follow_up_task", applyFollowUpTaskProposal);
}
