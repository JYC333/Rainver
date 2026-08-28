import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const importedSessionsModule: ServerModule = {
  name: "importedSessions",
  registerRoutes,
};
