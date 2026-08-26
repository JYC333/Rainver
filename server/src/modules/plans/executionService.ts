import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { PgPlanRepository, type PlanExecuteInput } from "./repository.js";

/**
 * Plan execution boundary. Read/materialization queries remain in the Plan
 * repository; callers use this service for coordinator lifecycle and durable
 * node-run reconciliation.
 */
export class PlanExecutionService {
  private readonly repository: PgPlanRepository;

  constructor(db: Queryable) {
    this.repository = new PgPlanRepository(db);
  }

  execute(identity: SpaceUserIdentity, planId: string, input: PlanExecuteInput) {
    return this.repository.executePlan(identity, planId, input);
  }

  reconcile(identity: SpaceUserIdentity, planId: string) {
    return this.repository.reconcilePlan(identity, planId);
  }

  reconcileForRun(spaceId: string, runId: string, userId?: string): Promise<void> {
    return this.repository.reconcileForRun(spaceId, runId, userId);
  }
}
