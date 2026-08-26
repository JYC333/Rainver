import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerEvolutionReviewAutonomyDiscoverer } from "./autonomyDiscoverer.js";

export const evolutionModule: ServerModule = {
  name: "evolution",
  registerRoutes: (app, context) => {
    registerEvolutionReviewAutonomyDiscoverer();
    registerRoutes(app, context);
  },
};

export {
  __setEvolvableAssetRepositoryFactoryForTests,
  __setEvolvableAssetEvaluationRepositoryFactoryForTests,
} from "./assetRoutes.js";
export { EvolvableAssetRepository } from "./assetRepository.js";
export { EvolvableAssetEvaluationRepository } from "./assetEvaluationRepository.js";
export { resolveEvolvableAssetVersion } from "./assetResolutionService.js";
export type { ResolveEvolvableAssetVersionInput, ResolvedEvolvableAssetVersion } from "./assetResolutionService.js";
export { registerEvolvableAssetPromotionProposalApplier } from "./assetPromotionProposalApplier.js";
export { EvolutionBundleRepository } from "./bundleRepository.js";
export {
  EvolutionSignalEmitter,
  SIGNAL_DEDUP_WINDOWS_SECONDS,
  buildRunFinalizationRules,
  proposalSignalType,
} from "./signalEmitters.js";
