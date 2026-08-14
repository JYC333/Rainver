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
  private readonly handlers = new Map<string, { handler: WorkflowExecutionOutcomeHandler; owner: string }>();

  register(workflowId: string, handler: WorkflowExecutionOutcomeHandler, owner: string): void {
    if (!workflowId.trim()) throw new Error("workflowId must be non-empty");
    if (!owner.trim()) throw new Error("owner must be non-empty");
    const existing = this.handlers.get(workflowId);
    if (existing && existing.owner !== owner) {
      throw new Error(`${workflowId} is already registered by ${existing.owner}`);
    }
    this.handlers.set(workflowId, { handler, owner });
  }

  get(workflowId: string): WorkflowExecutionOutcomeHandler | null {
    return this.handlers.get(workflowId)?.handler ?? null;
  }

  registeredKeys(): ReadonlySet<string> {
    return new Set(this.handlers.keys());
  }

  __resetForTests(): void {
    this.handlers.clear();
  }
}

export const workflowExecutionOutcomeHandlerRegistry =
  new WorkflowExecutionOutcomeHandlerRegistry();
