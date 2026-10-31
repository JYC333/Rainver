import {registerRevisionProviderRuns} from './reading/providerGeneration.js';
import {registerReadingGenerationSettlement} from './reading/generation.js';
import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

import {registerReadingMethodRoutes} from './reading/routes.js';
import {registerReadingTrialSettlement} from './reading/trials.js';
export const promptsModule: ServerModule = { name: "prompts", registerRoutes: (app,context)=>{registerReadingTrialSettlement();registerReadingGenerationSettlement();registerRevisionProviderRuns();registerRoutes(app,context);registerReadingMethodRoutes(app,context);} };

export { __setPromptRepositoryFactoryForTests } from "./routes.js";
export { PromptRepository } from "./repository.js";
export { loadPromptManifests, syncBuiltinPrompts } from "./builtins.js";
export type { PromptManifest, PromptSyncResult } from "./builtins.js";
export { resolvePrompt } from "./resolver.js";
export type { ResolvePromptInput } from "./resolver.js";
export { missingRequiredVariables, renderPromptMessages, renderPromptTemplate } from "./renderer.js";
export { promptProvenanceOf, withPromptProvenance } from "./provenance.js";
export type { PromptProvenance } from "./provenance.js";
export { freezeReadingMethod, assertFrozenReadingMethod, readingMethodBlock, readingMethodOf } from './reading/runtime.js';

export {closeReadingContext} from './reading/closedContext.js';

export {registerRevisionProviderRuns} from "./reading/providerGeneration.js";

export {registerReadingProviderReconciliation} from './reading/providerReconciliation.js';
export {assertRevisionProvider as assertReadingProviderEgress} from './reading/revisionProvider.js';
export {readingProviderOf} from './reading/generationContract.js';

export {isReadingMethodExecutor} from './reading/closedContext.js';
