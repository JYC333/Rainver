import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerTasksProjectIntegration } from "./projectIntegration.js";

function register(app: Parameters<typeof registerRoutes>[0], context: Parameters<typeof registerRoutes>[1]): void {
  registerTasksProjectIntegration();
  registerRoutes(app, context);
}

export const tasksModule: ServerModule = {
  name: "tasks",
  registerRoutes: register,
};
