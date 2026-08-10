import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const crossSpaceRetrievalModule: ServerModule = {
  name: "crossSpaceRetrieval",
  registerRoutes,
};
