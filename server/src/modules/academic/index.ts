import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const academicModule: ServerModule = {
  name: "academic",
  registerRoutes,
};

export { __setAcademicServiceFactoryForTests } from "./routes.js";
export { AcademicService } from "./service.js";
export { materializeAcademicPaperFromSourceItem } from "./paperMaterializer.js";
export type { MaterializeAcademicPaperResult } from "./paperMaterializer.js";
