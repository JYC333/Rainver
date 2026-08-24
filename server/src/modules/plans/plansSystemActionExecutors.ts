import type { SystemActionId } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { SystemActionExecutor } from "../systemActions/gateway";
import type { RunRecord } from "../runs/repository";
import { PgPlanRepository } from "./repository";

/** `task.plan.propose` (action authority consolidation plan, P1.5). */
export function registerPlansSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const db = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  executors.set("task.plan.propose" as SystemActionId, async (input, context) => {
    const body = input as Record<string, unknown>;
    const plan = await new PgPlanRepository(db).createPlanFromAgent(identity, {
      sourceTaskId: String(body.task_id ?? ""),
      planId: typeof body.plan_id === "string" ? body.plan_id : null,
      planningRunId: run.id,
      planningToolCallId: context.idempotency_key ?? "",
      agentId: run.agent_id,
      definitionJson: body.definition_json,
      referenceWorkflowVersionId: typeof body.reference_workflow_version_id === "string" ? body.reference_workflow_version_id : null,
      budgetCap: typeof body.budget_cap === "number" ? body.budget_cap : null,
      plannerMetadata: body.planner_metadata && typeof body.planner_metadata === "object" && !Array.isArray(body.planner_metadata) ? body.planner_metadata as Record<string, unknown> : null,
    });
    return {
      modelResult: { ok: true, plan },
      summary: { tool_name: "task.plan.propose", ok: true, plan_id: (plan as { id?: string }).id, plan_version_id: (plan as { current_version?: { id?: string } }).current_version?.id },
    };
  });
}
