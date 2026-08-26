import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const crossSpaceRetrievalModule: ServerModule = {
  name: "crossSpaceRetrieval",
  registerRoutes,
};
