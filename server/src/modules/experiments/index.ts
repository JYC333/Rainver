import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const experimentsModule: ServerModule = { name: "experiments", registerRoutes };

export { ExperimentDefinitionService } from "./definitionService.js";
export { ExperimentRunService } from "./runService.js";
export { ExperimentInterpretationService } from "./interpretationService.js";
