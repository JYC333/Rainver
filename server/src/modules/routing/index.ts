import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const routingModule: ServerModule = { name: "routing", registerRoutes };

export { DeterministicRouteSelector, EMPTY_ROUTE_HINTS, mergeRouteHints } from "./router.js";
export { PgRouteDecisionRepository, RouteSelectionError, routeHintsForRun } from "./repository.js";
export type * from "./types.js";
