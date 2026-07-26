import type { FastifyInstance } from "fastify";
import type { ModuleContext, ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes as registerDecisionRoutes } from "./routes";
import { registerDecisionsProjectIntegration } from "./projectIntegration";

function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerDecisionsProjectIntegration();
  registerDecisionRoutes(app, context);
}

export const decisionsModule: ServerModule = { name: "decisions", registerRoutes };

export { DecisionCaseService } from "./caseService";
