import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerContextOpsReviewCycleAutomationTarget } from "./automationTarget.js";

export const contextOpsModule: ServerModule = {
  name: "contextOps",
  registerRoutes: (app, context) => {
    registerContextOpsReviewCycleAutomationTarget();
    registerRoutes(app, context);
  },
};

export { ContextOpsService } from "./service.js";
