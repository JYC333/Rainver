import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const relationsModule: ServerModule = {
  name: "relations",
  registerRoutes,
};

export { __setRelationsServiceFactoryForTests } from "./routes.js";
export { RelationsService } from "./service.js";
