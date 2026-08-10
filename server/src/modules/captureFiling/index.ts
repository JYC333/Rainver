import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const captureFilingModule: ServerModule = {
  name: "captureFiling",
  registerRoutes,
};
