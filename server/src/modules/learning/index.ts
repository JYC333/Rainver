import type { FastifyInstance } from "fastify";
import type { ModuleContext, ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes as registerLearningRoutes } from "./routes";
import { registerLearningProjectIntegration } from "./projectIntegration";

function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerLearningProjectIntegration();
  registerLearningRoutes(app, context);
}

export const learningModule: ServerModule = { name: "learning", registerRoutes };

export { LearningService } from "./service";
