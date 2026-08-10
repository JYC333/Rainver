import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes as registerProjectResearchRoutes } from "./routes";
import { registerProjectResearchProjectIntegration } from "./projectIntegration";

function registerRoutes(
  app: Parameters<typeof registerProjectResearchRoutes>[0],
  context: Parameters<typeof registerProjectResearchRoutes>[1],
): void {
  registerProjectResearchProjectIntegration();
  registerProjectResearchRoutes(app, context);
}

export const projectResearchModule: ServerModule = {
  name: "project_research",
  registerRoutes,
};

export { registerProjectResearchProjectIntegration } from "./projectIntegration";

export { __setProjectResearchRepositoryFactoryForTests, __setProjectResearchOrchestratorFactoryForTests } from "./routes";
export { ProjectResearchRepository } from "./repository";
export { ProjectResearchReportRepository } from "./reportRepository";
export { ProjectResearchOrchestrator, registerProjectResearchHandler } from "./orchestrator";
export { ProjectResearchPipelineService } from "./pipeline/researchPipelineService";
export { ProjectResearchExecutionProfileService } from "./executionProfileService";
export {
  PROJECT_RESEARCH_SYNTHESIS_PROMPT_KEY,
  resolveProjectResearchSynthesisPrompt,
} from "./promptRegistry";
