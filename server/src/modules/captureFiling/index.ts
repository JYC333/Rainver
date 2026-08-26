import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const captureFilingModule: ServerModule = {
  name: "captureFiling",
  registerRoutes,
};
