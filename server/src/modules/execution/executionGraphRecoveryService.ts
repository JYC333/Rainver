import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { PlanExecutionService } from "../plans/executionService.js";
import { WorkflowExecutionService } from "../automations/workflowExecutionService.js";
import type { OperationalAlertPort } from "../notifications/operationalAlerts.js";
import { safelyEmitOperationalAlert } from "../notifications/operationalAlerts.js";

export class ExecutionGraphRecoveryService {
  constructor(
    private readonly db: Queryable,
    config: ServerConfig,
    private readonly alerts?: OperationalAlertPort | null,
    private readonly log?: { warn(message: string): void },
    private readonly reconcilePlan: (spaceId: string, userId: string, planId: string) => Promise<unknown> =
      (spaceId, userId, planId) => new PlanExecutionService(db).reconcile({ spaceId, userId }, planId),
    private readonly reconcileWorkflow: (spaceId: string, userId: string, executionId: string) => Promise<unknown> =
      (spaceId, userId, executionId) => new WorkflowExecutionService(config).reconcile(db, spaceId, executionId, userId),
  ) {}

  // Where the previous scan stopped. Reconciling a graph that is simply still
  // waiting writes nothing, so a scan that always restarted at the oldest rows
  // would revisit the same `limit` graphs forever and never reach the rest.
  private planCursor: ScanCursor | null = null;
  private workflowCursor: ScanCursor | null = null;

  async reconcileActive(limit = 50): Promise<{ plans: number; workflows: number; failures: number }> {
    const plans = await this.db.query<ScanRow>(
      `SELECT p.id, p.space_id, root.owner_user_id AS user_id, p.updated_at::text AS sort_at
         FROM plans p
         JOIN runs root ON root.id = p.root_run_id AND root.space_id = p.space_id
        WHERE p.status = 'active' AND root.status = 'waiting_for_dependency'
          AND ($2::timestamptz IS NULL OR (p.updated_at, p.id) > ($2::timestamptz, $3::varchar))
        ORDER BY p.updated_at ASC, p.id ASC LIMIT $1`,
      [limit, this.planCursor?.sortAt ?? null, this.planCursor?.id ?? null],
    );
    this.planCursor = nextCursor(plans.rows, limit);
    const workflows = await this.db.query<ScanRow>(
      `SELECT execution.id, execution.space_id, automation.owner_user_id AS user_id, execution.updated_at::text AS sort_at
         FROM workflow_executions execution
         JOIN automations automation ON automation.id = execution.automation_id AND automation.space_id = execution.space_id
         LEFT JOIN runs root ON root.id = execution.root_run_id AND root.space_id = execution.space_id
        WHERE execution.status IN ('queued', 'running')
          AND (root.id IS NULL OR root.status = 'waiting_for_dependency')
          AND ($2::timestamptz IS NULL OR (execution.updated_at, execution.id) > ($2::timestamptz, $3::varchar))
        ORDER BY execution.updated_at ASC, execution.id ASC LIMIT $1`,
      [limit, this.workflowCursor?.sortAt ?? null, this.workflowCursor?.id ?? null],
    );
    this.workflowCursor = nextCursor(workflows.rows, limit);
    let recoveredPlans = 0;
    let recoveredWorkflows = 0;
    let failures = 0;
    for (const plan of plans.rows) {
      try {
        await this.reconcilePlan(plan.space_id, plan.user_id ?? "system", plan.id);
        recoveredPlans += 1;
      } catch (error) {
        failures += 1;
        await this.reportFailure("plan", plan.space_id, plan.id, plan.user_id, error);
      }
    }
    for (const workflow of workflows.rows) {
      try {
        await this.reconcileWorkflow(workflow.space_id, workflow.user_id ?? "system", workflow.id);
        recoveredWorkflows += 1;
      } catch (error) {
        failures += 1;
        await this.reportFailure("workflow", workflow.space_id, workflow.id, workflow.user_id, error);
      }
    }
    return { plans: recoveredPlans, workflows: recoveredWorkflows, failures };
  }

  private async reportFailure(
    kind: "plan" | "workflow",
    spaceId: string,
    id: string,
    userId: string | null,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.log?.warn(`[execution-graph-recovery] ${kind} ${id} failed: ${message}`);
    await safelyEmitOperationalAlert(this.alerts, {
      kind: "scheduler_task_failed",
      title: `Execution graph recovery failed: ${kind}`,
      message: `Recovery of ${kind} '${id}' failed: ${message}`,
      dedupeKey: `execution_graph_recovery:${kind}:${id}`,
      spaceId,
      userId,
      payload: { graph_kind: kind, graph_id: id },
    });
  }
}

interface ScanRow {
  id: string;
  space_id: string;
  user_id: string | null;
  sort_at: string;
}

interface ScanCursor {
  sortAt: string;
  id: string;
}

/** Continue after the last row of a full page; wrap to the start after a short one. */
function nextCursor(rows: readonly ScanRow[], limit: number): ScanCursor | null {
  const last = rows.at(-1);
  return rows.length >= limit && last ? { sortAt: last.sort_at, id: last.id } : null;
}
