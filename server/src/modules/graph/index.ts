import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const graphModule: ServerModule = { name: "graph", registerRoutes };
