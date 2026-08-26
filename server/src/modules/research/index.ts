import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
export const researchModule: ServerModule = { name: "research", registerRoutes };
