/**
 * Catalog module routes (server-owned).
 *
 * - GET /api/v1/server/catalog                  summary (availability + counts)
 * - GET /api/v1/server/catalog/capabilities     capability manifest summaries
 * - GET /api/v1/server/catalog/agent-templates  agent template spec summaries
 *
 * Read-only descriptors of the on-disk `catalog/` definitions. Product
 * capability APIs live in `modules/capabilities` under
 * `/api/v1/capability-definitions`; catalog is no longer a public capability
 * surface.
 */

import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { catalogSummary, listAgentTemplates, listCapabilities } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const catalogRoot = context.config.catalogRoot;
  app.get("/api/v1/server/catalog", async () => catalogSummary(catalogRoot));
  app.get("/api/v1/server/catalog/capabilities", async () =>
    listCapabilities(catalogRoot),
  );
  app.get("/api/v1/server/catalog/agent-templates", async () =>
    listAgentTemplates(catalogRoot),
  );
}
