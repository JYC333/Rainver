import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

/**
 * The module object the route registry mounts, and nothing else: every other
 * consumer imports the file it needs. A barrel that re-exports the routes,
 * service and repository together makes one import load the whole module —
 * `server/test/testHygiene.test.ts` enforces that for test files.
 */
export const deploymentModule: ServerModule = {
  name: "deployment",
  registerRoutes,
};
