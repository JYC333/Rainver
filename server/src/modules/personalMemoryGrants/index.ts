import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const personalMemoryGrantsModule: ServerModule = {
  name: "personalMemoryGrants",
  registerRoutes,
};
