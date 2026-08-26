import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerAutomationsProjectIntegration } from "./projectIntegration.js";
import { automationTargetHandlerRegistry } from "./targetRegistry.js";
import { registerAutomationOwnedTargetHandlers } from "./targetHandlers.js";
import { loadAutomationTargetDefinitions } from "./targetDefinitions.js";

function register(app: Parameters<typeof registerRoutes>[0], context: Parameters<typeof registerRoutes>[1]): void {
  registerAutomationOwnedTargetHandlers();
  app.addHook("onReady", async () => {
    const definitions = await loadAutomationTargetDefinitions();
    automationTargetHandlerRegistry.assertComplete(definitions.keys());
  });
  registerAutomationsProjectIntegration();
  registerRoutes(app, context);
}

export const automationsModule: ServerModule = {
  name: "automations",
  registerRoutes: register,
};
