import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";
import { registerRetrievalMaintenanceAutomationTarget } from "../retrieval/automationTarget";

export const knowledgeModule: ServerModule = {
  name: "knowledge",
  registerRoutes: (app, context) => {
    registerRetrievalMaintenanceAutomationTarget();
    registerRoutes(app, context);
  },
};
