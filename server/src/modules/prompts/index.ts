import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const promptsModule: ServerModule = { name: "prompts", registerRoutes };

export { __setPromptRepositoryFactoryForTests } from "./routes.js";
export { PromptRepository } from "./repository.js";
export { loadPromptManifests, syncBuiltinPrompts } from "./builtins.js";
export type { PromptManifest, PromptSyncResult } from "./builtins.js";
export { resolvePrompt } from "./resolver.js";
export type { ResolvePromptInput } from "./resolver.js";
export { missingRequiredVariables, renderPromptMessages, renderPromptTemplate } from "./renderer.js";
export { promptProvenanceOf, withPromptProvenance } from "./provenance.js";
export type { PromptProvenance } from "./provenance.js";
