import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const usageModule: ServerModule = {
  name: "usage",
  registerRoutes,
};

export { normalizeUsageObservation, normalizeUsageDetails } from "./normalizer.js";
export {
  estimateModelTokens,
  resolveModelWindow,
  trimTextToModelTokens,
  type ModelWindowOverride,
  type ModelWindowSpec,
} from "./modelCatalog.js";
export {
  PgUsageRepository,
  usageRepositoryFromPool,
  type UsageQueryFilters,
  type UsageRunSummaryRecord,
} from "./repository.js";
export {
  UsageService,
  recordAttributedUsageObservation,
  recordUsageObservation,
  resolveUsageObservationAttribution,
  usageServiceFromConfig,
  type UsageIdentity,
  type UsageQueryInput,
} from "./service.js";
export type {
  NormalizedUsageObservation,
  UsageAttribution,
  UsageObservation,
} from "./types.js";
