import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const agentGroupsModule: ServerModule = {
  name: "agentGroups",
  registerRoutes,
};

export { __setAgentGroupsServiceFactoryForTests } from "./routes.js";
export { AgentGroupRunService, authorityWidening } from "./service.js";
export { PgAgentGroupRepository } from "./repository.js";
export { AgentGroupRuntimeDelegationMaterializer } from "./runtimeDelegationMaterializer.js";
export { AgentGroupRunLifecycleProjector } from "./lifecycleProjector.js";
