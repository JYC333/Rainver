import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const readerModule: ServerModule = { name: "reader", registerRoutes };
export * from "./repository.js";
