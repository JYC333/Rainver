import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const runsModule: ServerModule = {
  name: "runs",
  registerRoutes,
};

export {
  __setRunsCommandServicesFactoryForTests,
  __setRunsIdentityForTests,
  __setRunsReadResponseForTests,
} from "./routes.js";
