import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const focusAreasModule: ServerModule = {
  name: "focusAreas",
  registerRoutes,
};

export { FocusAreaService, type FocusArea, type FocusAreaContents } from "./service.js";
