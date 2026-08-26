import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes as registerProjectResearchRoutes } from "./routes.js";
import { registerProjectResearchProjectIntegration } from "./projectIntegration.js";
import { registerProjectResearchExecutionHandlers } from "./executionRegistration.js";

function registerRoutes(
  app: Parameters<typeof registerProjectResearchRoutes>[0],
  context: Parameters<typeof registerProjectResearchRoutes>[1],
): void {
  registerProjectResearchProjectIntegration();
  registerProjectResearchExecutionHandlers();
  registerProjectResearchRoutes(app, context);
}

export const projectResearchModule: ServerModule = {
  name: "project_research",
  registerRoutes,
};

export { registerProjectResearchProjectIntegration } from "./projectIntegration.js";
export { registerProjectResearchExecutionHandlers } from "./executionRegistration.js";

export { __setProjectResearchRepositoryFactoryForTests, __setProjectResearchOrchestratorFactoryForTests } from "./routes.js";
export { ProjectResearchRepository } from "./repository.js";
export { ProjectResearchReportRepository } from "./reportRepository.js";
export { ProjectResearchOrchestrator, registerProjectResearchHandler } from "./orchestrator.js";
export { ProjectResearchPipelineService } from "./pipeline/researchPipelineService.js";
export { ProjectResearchExecutionProfileService } from "./executionProfileService.js";
export {
  PROJECT_RESEARCH_SYNTHESIS_PROMPT_KEY,
  resolveProjectResearchSynthesisPrompt,
} from "./promptRegistry.js";
