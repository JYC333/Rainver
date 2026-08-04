import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";
import { registerContextOpsReviewCycleAutomationTarget } from "./automationTarget";

export const contextOpsModule: ServerModule = {
  name: "contextOps",
  registerRoutes: (app, context) => {
    registerContextOpsReviewCycleAutomationTarget();
    registerRoutes(app, context);
  },
};

export { ContextOpsService } from "./service";
