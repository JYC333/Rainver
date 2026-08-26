import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const deploymentModule: ServerModule = {
  name: "deployment",
  registerRoutes,
};

export { ALLOWED_DEPLOYER_JOB_TYPES, DeployerSocketClient } from "./client.js";
