/**
 * Catalog module — read-only surface over the built-in `catalog/` definitions,
 * packaged in the standard server-owned module shape (`ServerModule`).
 *
 * `/api/v1/server/catalog*` lists those manifests. Product capabilities come
 * from `modules/capabilities` and do not read this catalog. Do not route a
 * product capability through a catalog manifest. `/api/v1/agent-templates`
 * reads `catalog/agent_templates` on its own.
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
