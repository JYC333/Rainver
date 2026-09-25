import { runFinalizationReconcilerRegistry } from "../runs/finalizationReconcilerRegistry.js";
import { settleTasksForRun } from "./settlement.js";

/**
 * Run settlement is triggered from finalization, and only from there.
 * Finalization is where the evaluation is bridged into `task_evaluations`
 * and where the Supervisor decides retry-or-hold, and the registry runs after
 * both — so this is the first moment the settlement decision has the facts
 * it is defined on. A cancelled Run is finalized too (nothing to evaluate,
 * so at once), by the route that cancelled it or by the jobs worker's sweep
 * of terminal Task Runs nobody finalized (`reconcileUnfinalizedTaskRuns`).
 */
export function registerProjectWorkRunFinalizationReconciler(): void {
  runFinalizationReconcilerRegistry.register("project_work", {
    reconcile: (db, run) => settleTasksForRun(db, run.space_id, run.id).then(() => undefined),
  }, "projectWork");
}
