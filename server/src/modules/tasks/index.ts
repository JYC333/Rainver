import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";
import { registerTasksProjectIntegration } from "./projectIntegration";

function register(app: Parameters<typeof registerRoutes>[0], context: Parameters<typeof registerRoutes>[1]): void {
  registerTasksProjectIntegration();
  registerRoutes(app, context);
}

export const tasksModule: ServerModule = {
  name: "tasks",
  registerRoutes: register,
};
