import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const artifactsModule: ServerModule = {
  name: "artifacts",
  registerRoutes,
};

export {
  __setArtifactIdentityForTests,
  __setArtifactRepositoryFactoryForTests,
} from "./routes.js";
