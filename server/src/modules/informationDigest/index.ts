import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";
import { registerInformationDigestAutomationTarget } from "./automationTarget";

export const informationDigestModule: ServerModule = {
  name: "informationDigest",
  registerRoutes: (app, context) => {
    registerInformationDigestAutomationTarget();
    registerRoutes(app, context);
  },
};
