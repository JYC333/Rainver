import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerInformationDigestAutomationTarget } from "./automationTarget.js";
import { registerBriefingRoutes } from "./briefing/routes.js";
import { registerBriefingSettlement } from "./briefing/settlement.js";

export const informationDigestModule: ServerModule = {
  name: "informationDigest",
  registerRoutes: (app, context) => {
    registerInformationDigestAutomationTarget();
    registerBriefingSettlement();
    registerRoutes(app, context);
    registerBriefingRoutes(app, context);
  },
};
