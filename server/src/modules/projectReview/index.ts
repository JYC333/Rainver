import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const projectReviewModule: ServerModule = { name: "project_review", registerRoutes };
