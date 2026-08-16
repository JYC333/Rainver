import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const capabilitiesModule: ServerModule = {
  name: "capabilities",
  registerRoutes,
};

export {
  assertPackReferencesValid,
  getBuiltInCapabilityPack,
  listBuiltInCapabilityPacks,
} from "./packRegistry";
export {
  assertUniqueCapabilityIds,
  getBuiltInCapabilityDefinition,
  listBuiltInCapabilityDefinitions,
} from "./registry";
export { parseSkillMarkdown } from "./skillParser";
export { analyzeSkillRisk } from "./skillRisk";
export {
  previewSkillImport,
  type SkillFetcher,
  type SkillImportOptions,
  type SkillPackageLister,
  type SkillPackageTreeEntry,
} from "./skillImporter";
export {
  renderAllRuntimeSkills,
  renderClaudeSkill,
  renderCodexSkill,
  renderGenericPromptSkill,
} from "./runtimeRenderers";
export {
  PgRuntimeSkillProvider,
  renderRuntimeSkillCandidate,
  type RenderedRuntimeSkill,
  type RuntimeSkillCandidate,
  type RuntimeSkillProvider,
  type RuntimeSkillRunContext,
} from "./runtimeSkillProvider";
export { CapabilitiesService } from "./service";
export { PgCapabilitiesRepository } from "./repository";
export {
  __setCapabilitiesIdentityForTests,
  __setCapabilitiesRepositoryFactoryForTests,
  __setCapabilitiesSkillFetcherForTests,
} from "./routes";
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
} from "./types";
