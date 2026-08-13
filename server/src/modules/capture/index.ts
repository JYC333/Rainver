import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const captureModule: ServerModule = {
  name: "capture",
  registerRoutes,
};
