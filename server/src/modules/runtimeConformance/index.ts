import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const runtimeConformanceModule: ServerModule = {
  name: "runtimeConformance",
  registerRoutes,
};

export {
  CONFORMANCE_CHECKS,
  CONFORMANCE_SUITE_VERSION,
  RuntimeConformanceService,
  type ConformanceCheck,
  type ConformanceCheckObservation,
  type ConformanceProbeContext,
  type ConformanceProbeRunner,
  type ConformanceResult,
} from "./service.js";
export {
  LocalCliConformanceProbeRunner,
  type LocalCliConformanceProbeRunnerDeps,
} from "./probeRunner.js";
