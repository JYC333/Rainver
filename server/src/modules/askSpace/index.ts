import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const askSpaceModule: ServerModule = {
  name: "askSpace",
  registerRoutes,
};

export { AskSpaceService } from "./service.js";
