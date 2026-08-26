import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const agentsModule: ServerModule = {
  name: "agents",
  registerRoutes,
};

export {
  __setAgentChatIdentityForTests,
  __setAgentChatServicesFactoryForTests,
} from "./routes.js";
export { PgAgentRepository } from "./repository.js";
