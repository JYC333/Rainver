import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";
import { registerEvolutionReviewAutonomyDiscoverer } from "./autonomyDiscoverer";

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
} from "./assetRoutes";
export { EvolvableAssetRepository } from "./assetRepository";
export { EvolvableAssetEvaluationRepository } from "./assetEvaluationRepository";
export { resolveEvolvableAssetVersion } from "./assetResolutionService";
export type { ResolveEvolvableAssetVersionInput, ResolvedEvolvableAssetVersion } from "./assetResolutionService";
export { registerEvolvableAssetPromotionProposalApplier } from "./assetPromotionProposalApplier";
export { EvolutionBundleRepository } from "./bundleRepository";
export {
  EvolutionSignalEmitter,
  SIGNAL_DEDUP_WINDOWS_SECONDS,
  buildRunFinalizationRules,
  proposalSignalType,
} from "./signalEmitters";
