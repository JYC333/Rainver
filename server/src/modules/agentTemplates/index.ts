import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const agentTemplatesModule: ServerModule = { name: "agentTemplates", registerRoutes };
