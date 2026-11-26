import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const agentRolesModule: ServerModule = { name: "agentRoles", registerRoutes };
