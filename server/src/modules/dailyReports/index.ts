import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const dailyReportsModule: ServerModule = {
  name: "dailyReports",
  registerRoutes,
};
