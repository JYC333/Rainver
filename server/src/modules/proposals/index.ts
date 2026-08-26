import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const proposalsModule: ServerModule = {
  name: "proposals",
  registerRoutes,
};

export {
  __setProposalIdentityForTests,
  __setProposalServicesFactoryForTests,
} from "./routes.js";
