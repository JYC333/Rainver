import type { FastifyInstance } from "fastify";
import type { ModuleContext, ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes as registerDecisionRoutes } from "./routes.js";
import { registerDecisionsProjectIntegration } from "./projectIntegration.js";

function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerDecisionsProjectIntegration();
  registerDecisionRoutes(app, context);
}

export const decisionsModule: ServerModule = { name: "decisions", registerRoutes };

export { DecisionCaseService } from "./caseService.js";
