/**
 * Catalog module — read-only surface over the built-in `catalog/` definitions,
 * packaged in the standard server-owned module shape (`ServerModule`).
 *
 * `/api/v1/server/catalog*` lists diagnostic manifests. The original-package
 * Skill library in `modules/skills` does not use catalog manifests as an
 * authority. `/api/v1/agent-templates` reads `catalog/agent_templates` separately.
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
