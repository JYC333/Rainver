import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const publicationsModule: ServerModule = {
  name: "publications",
  registerRoutes,
};
