import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";
import { registerAutomationsProjectIntegration } from "./projectIntegration";

function register(app: Parameters<typeof registerRoutes>[0], context: Parameters<typeof registerRoutes>[1]): void {
  registerAutomationsProjectIntegration();
  registerRoutes(app, context);
}

export const automationsModule: ServerModule = {
  name: "automations",
  registerRoutes: register,
};
