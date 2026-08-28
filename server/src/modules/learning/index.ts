import type { FastifyInstance } from "fastify";
import type { ModuleContext, ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes as registerLearningRoutes } from "./routes.js";

function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerLearningRoutes(app, context);
}

export const learningModule: ServerModule = { name: "learning", registerRoutes };

export { LearningService } from "./service.js";
