/**
 * Catalog module — read-only surface over the built-in `catalog/` definitions,
 * packaged in the standard server-owned module shape (`ServerModule`).
 *
 * Built-in catalog manifests are served directly by the server. The
 * product-shaped capability and template-library routes adapt the same source
 * definitions for the frontend.
 */

import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const catalogModule: ServerModule = {
  name: "catalog",
  registerRoutes,
};

export {
  catalogSummary,
  listAgentTemplates,
  listCapabilities,
  type CatalogAgentTemplateSummary,
  type CatalogCapabilitySummary,
  type CatalogListBody,
  type CatalogSummaryBody,
} from "./service.js";
