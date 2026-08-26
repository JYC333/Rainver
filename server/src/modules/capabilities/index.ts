import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const capabilitiesModule: ServerModule = {
  name: "capabilities",
  registerRoutes,
};

export {
  assertPackReferencesValid,
  getBuiltInCapabilityPack,
  listBuiltInCapabilityPacks,
} from "./packRegistry.js";
export {
  assertUniqueCapabilityIds,
  getBuiltInCapabilityDefinition,
  listBuiltInCapabilityDefinitions,
} from "./registry.js";
export { parseSkillMarkdown } from "./skillParser.js";
export { analyzeSkillRisk } from "./skillRisk.js";
export {
  previewSkillImport,
  type SkillFetcher,
  type SkillImportOptions,
  type SkillPackageLister,
  type SkillPackageTreeEntry,
} from "./skillImporter.js";
export {
  renderAllRuntimeSkills,
  renderClaudeSkill,
  renderCodexSkill,
  renderGenericPromptSkill,
} from "./runtimeRenderers.js";
export {
  PgRuntimeSkillProvider,
  renderRuntimeSkillCandidate,
  type RenderedRuntimeSkill,
  type RuntimeSkillCandidate,
  type RuntimeSkillProvider,
  type RuntimeSkillRunContext,
} from "./runtimeSkillProvider.js";
export { CapabilitiesService } from "./service.js";
export { PgCapabilitiesRepository } from "./repository.js";
export {
  __setCapabilitiesIdentityForTests,
  __setCapabilitiesRepositoryFactoryForTests,
  __setCapabilitiesSkillFetcherForTests,
} from "./routes.js";
export type {
  CapabilityDefinition,
  CapabilityPackDescriptor,
  CapabilityRuntimeBinding,
  NormalizedSkill,
  RuntimeRenderedSkill,
  SkillImportPreview,
  SkillPackage,
  SkillPackageFile,
  SkillPackageFilePreview,
  SkillRiskAnalysis,
} from "./types.js";
