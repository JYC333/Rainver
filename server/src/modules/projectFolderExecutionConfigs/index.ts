import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const projectFolderExecutionConfigsModule: ServerModule = {
  name: "project_folder_execution_configs",
  registerRoutes,
};
