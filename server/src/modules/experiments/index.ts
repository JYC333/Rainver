import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const experimentsModule: ServerModule = { name: "experiments", registerRoutes };

export { ExperimentDefinitionService } from "./definitionService";
export { ExperimentRunService } from "./runService";
export { ExperimentInterpretationService } from "./interpretationService";
