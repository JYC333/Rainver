import type { Queryable } from "../routeUtils/common";

export interface WorkflowExecutionOutcomeContext {
  db: Queryable;
  spaceId: string;
  executionId: string;
  workflowId: string;
  status: "completed" | "failed";
  researchOperationId: string | null;
}

export type WorkflowExecutionOutcomeHandler =
  (context: WorkflowExecutionOutcomeContext) => Promise<void>;

/**
 * Lets an owning domain project a terminal WorkflowExecution outcome back
 * into its own aggregate without making the generic Automations module write
 * domain tables directly.
 */
class WorkflowExecutionOutcomeHandlerRegistry {
  private readonly handlers = new Map<string, WorkflowExecutionOutcomeHandler>();

  register(workflowId: string, handler: WorkflowExecutionOutcomeHandler): void {
    if (!workflowId.trim()) throw new Error("workflowId must be non-empty");
    this.handlers.set(workflowId, handler);
  }

  get(workflowId: string): WorkflowExecutionOutcomeHandler | null {
    return this.handlers.get(workflowId) ?? null;
  }

  __resetForTests(): void {
    this.handlers.clear();
  }
}

export const workflowExecutionOutcomeHandlerRegistry =
  new WorkflowExecutionOutcomeHandlerRegistry();
