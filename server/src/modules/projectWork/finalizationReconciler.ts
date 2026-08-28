import { runFinalizationReconcilerRegistry } from "../runs/finalizationReconcilerRegistry.js";
import { projectTaskStatusFromRun } from "../tasks/taskRunStatusProjection.js";

/**
 * Run settlement is triggered from finalization, not from the terminal status
 * write. Finalization is where the evaluation is bridged into
 * `task_evaluations` and where the Supervisor decides retry-or-hold, and the
 * registry runs after both — so this is the first moment the settlement
 * decision has the facts it is defined on. The terminal-time call still runs
 * and still handles `cancelled`; for everything else it finds no finalized
 * Run and does nothing.
 */
export function registerProjectWorkRunFinalizationReconciler(): void {
  runFinalizationReconcilerRegistry.register("project_work", {
    reconcile: (db, run) => projectTaskStatusFromRun(db, run.space_id, run.id),
  }, "projectWork");
}
