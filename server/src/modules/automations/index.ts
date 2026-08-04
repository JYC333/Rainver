import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";
import { registerAutomationsProjectIntegration } from "./projectIntegration";
import { automationTargetHandlerRegistry } from "./targetRegistry";
import { registerAutomationOwnedTargetHandlers } from "./targetHandlers";
import { loadAutomationTargetDefinitions } from "./targetDefinitions";

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
