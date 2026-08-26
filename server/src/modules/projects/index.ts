import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerPeriodicDigestAutonomyDiscoverer } from "./autonomyDiscoverer.js";

export const projectsModule: ServerModule = {
  name: "projects",
  registerRoutes: (app, context) => {
    registerPeriodicDigestAutonomyDiscoverer();
    registerRoutes(app, context);
  },
};
