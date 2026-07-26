import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const projectFolderExecutionConfigsModule: ServerModule = {
  name: "project_folder_execution_configs",
  registerRoutes,
};
