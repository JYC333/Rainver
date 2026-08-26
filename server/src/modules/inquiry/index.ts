import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const inquiryModule: ServerModule = { name: "inquiry", registerRoutes };
