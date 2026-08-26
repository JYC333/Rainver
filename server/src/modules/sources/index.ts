import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const sourcesModule: ServerModule = {
  name: "sources",
  registerRoutes,
};
