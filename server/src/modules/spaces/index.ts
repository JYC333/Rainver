import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
export { __setSpaceRepositoryForTests, type SpaceRepository } from "./repository.js";

export const spacesModule: ServerModule = { name: "spaces", registerRoutes };
