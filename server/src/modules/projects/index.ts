import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";
import { registerPeriodicDigestAutonomyDiscoverer } from "./autonomyDiscoverer";

export const projectsModule: ServerModule = {
  name: "projects",
  registerRoutes: (app, context) => {
    registerPeriodicDigestAutonomyDiscoverer();
    registerRoutes(app, context);
  },
};
