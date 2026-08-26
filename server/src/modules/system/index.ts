/**
 * System module — the server's own health/features descriptors,
 * packaged in the standard server-owned module shape (`ServerModule`).
 */

import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const systemModule: ServerModule = {
  name: "system",
  registerRoutes,
};

export {
  SERVER_SERVICE_NAME,
  computeFeatures,
  isProtocolPackageDetected,
  type FeaturesBody,
  type HealthBody,
} from "./service.js";
