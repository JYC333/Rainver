import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const projectResearchModule: ServerModule = {
  name: "project_research",
  registerRoutes,
};

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
