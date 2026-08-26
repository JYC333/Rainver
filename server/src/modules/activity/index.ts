import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const activityModule: ServerModule = {
  name: "activity",
  registerRoutes,
};

