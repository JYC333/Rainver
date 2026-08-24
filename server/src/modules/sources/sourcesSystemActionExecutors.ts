import type { SystemActionId } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { SystemActionExecutor } from "../systemActions/gateway";
import type { RunRecord } from "../runs/repository";
import { SourceChannelService } from "./channels/sourceChannelService";
import { SourceBackfillPlanningService } from "./sourceBackfillService";

/**
 * `source.channel.propose_activation` and `source.backfill.propose_start`
 * (action authority consolidation plan, P1.4). Both draft a reviewable
 * Proposal; durable mutation happens only through the owning applier after
 * acceptance.
 */
export function registerSourcesSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("source.channel.propose_activation" as SystemActionId, async (input, context) => {
    const result = await new SourceChannelService(db, config).proposeActivation(identity, input as Record<string, unknown>, {
      agentId: run.agent_id,
      runId: run.id,
      idempotencyKey: context.idempotency_key,
      projectId: run.project_id,
    });
    return {
      modelResult: { ok: true, proposal: result.proposal },
      summary: { tool_name: "source.channel.propose_activation", ok: true, proposal_id: (result.proposal as { id?: string }).id, auto_applied: result.auto_applied },
    };
  });

  executors.set("source.backfill.propose_start" as SystemActionId, async (input, context) => {
    const body = input as Record<string, unknown>;
    const channelId = String(body.source_channel_id ?? "");
    const planId = String(body.source_backfill_plan_id ?? "");
    const result = await new SourceBackfillPlanningService(db, config).proposeStart(identity, channelId, planId, {
      agentId: run.agent_id,
      runId: run.id,
      idempotencyKey: context.idempotency_key,
      projectId: run.project_id,
    });
    return {
      modelResult: { ok: true, proposal: result.proposal },
      summary: { tool_name: "source.backfill.propose_start", ok: true, proposal_id: (result.proposal as { id?: string }).id, auto_applied: result.auto_applied },
    };
  });
}
