import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const projectReviewModule: ServerModule = { name: "project_review", registerRoutes };
