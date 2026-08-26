import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerRetrievalMaintenanceAutomationTarget } from "../retrieval/automationTarget.js";

export const knowledgeModule: ServerModule = {
  name: "knowledge",
  registerRoutes: (app, context) => {
    registerRetrievalMaintenanceAutomationTarget();
    registerRoutes(app, context);
  },
};
