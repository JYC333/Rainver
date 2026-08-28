import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerProjectWorkRunFinalizationReconciler } from "./finalizationReconciler.js";
import { registerRoutes } from "./routes.js";

/**
 * Project work: how a Project advances, and the record of it.
 *
 * Owns the append-only `project_work_events` stream, the Loop-stage fold
 * (`task_loop_states`), and the settlement that turns a finished Run into a
 * Task outcome. It sits between `tasks` (the editable work commitment) and
 * `runs` (one attempt at it) and owns neither.
 */
export {
  registerWorkEventKind,
  workEventKindDefinition,
  registeredWorkEventKinds,
  hasWorkEventKindDeclaration,
  type WorkEventKindDefinition,
} from "./eventKinds.js";
export {
  appendProjectWorkEvent,
  assertWorkEventKind,
  WorkEventWriteError,
  type WorkEventInput,
  type WorkEventWriteResult,
} from "./eventWriter.js";
export {
  currentLoopState,
  recordStageChange,
  type StageChangeInput,
  type TaskLoopStateRow,
} from "./loopState.js";
export {
  settleTasksForRun,
  declaredRequiredOutputs,
  outcomeForRun,
  SETTLED_RUN_STATUSES,
  type Outcome,
} from "./settlement.js";

export const projectWorkModule: ServerModule = {
  name: "projectWork",
  registerRoutes: (app, context) => {
    registerProjectWorkRunFinalizationReconciler();
    registerRoutes(app, context);
  },
};
