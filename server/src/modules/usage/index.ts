import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const usageModule: ServerModule = {
  name: "usage",
  registerRoutes,
};

export { normalizeUsageObservation, normalizeUsageDetails } from "./normalizer";
export {
  estimateModelTokens,
  resolveModelWindow,
  trimTextToModelTokens,
  type ModelWindowOverride,
  type ModelWindowSpec,
} from "./modelCatalog";
export {
  PgUsageRepository,
  usageRepositoryFromPool,
  type UsageQueryFilters,
  type UsageRunSummaryRecord,
} from "./repository";
export {
  UsageService,
  recordAttributedUsageObservation,
  recordUsageObservation,
  resolveUsageObservationAttribution,
  usageServiceFromConfig,
  type UsageIdentity,
  type UsageQueryInput,
} from "./service";
export type {
  NormalizedUsageObservation,
  UsageAttribution,
  UsageObservation,
} from "./types";
