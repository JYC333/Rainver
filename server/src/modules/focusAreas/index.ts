import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const focusAreasModule: ServerModule = {
  name: "focusAreas",
  registerRoutes,
};

export { FocusAreaService, type FocusArea, type FocusAreaContents } from "./service";
