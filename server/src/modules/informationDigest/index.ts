import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerInformationDigestAutomationTarget } from "./automationTarget.js";

export const informationDigestModule: ServerModule = {
  name: "informationDigest",
  registerRoutes: (app, context) => {
    registerInformationDigestAutomationTarget();
    registerRoutes(app, context);
  },
};
