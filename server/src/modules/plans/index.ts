import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const plansModule: ServerModule = { name: "plans", registerRoutes };

export {
  PLAN_GRAPH_LIMITS,
  PLAN_GRAPH_VERSION,
  PlanGraphError,
  decidePlanApproval,
  evaluatePlanAtomicity,
  materializePlanGraph,
  planNodeContentHash,
} from "./graph.js";
export { PgPlanRepository } from "./repository.js";
export { PlanExecutionService } from "./executionService.js";
