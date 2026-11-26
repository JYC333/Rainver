/**
 * Catalog module routes (server-owned).
 *
 * - GET /api/v1/server/catalog                  summary (availability + counts)
 * - GET /api/v1/server/catalog/capabilities     capability manifest summaries
 * - GET /api/v1/server/catalog/agent-roles  agent role spec summaries
 *
 * Read-only descriptors of the on-disk `catalog/` definitions.
 * Skill library APIs live in `modules/skills`; this catalog is read-only
 * diagnostic descriptors and confers no execution authority.
 */

import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { resolveIdentity } from "../routeUtils/common.js";
import { catalogSummary, listAgentRoles, listCapabilities } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const catalogRoot = context.config.catalogRoot;
  app.get("/api/v1/server/catalog", async (request, reply) => {
    if (!(await resolveIdentity(context.config, request, reply))) return reply;
    return catalogSummary(catalogRoot);
  });
  app.get("/api/v1/server/catalog/capabilities", async (request, reply) => {
    if (!(await resolveIdentity(context.config, request, reply))) return reply;
    return listCapabilities(catalogRoot);
  });
  app.get("/api/v1/server/catalog/agent-roles", async (request, reply) => {
    if (!(await resolveIdentity(context.config, request, reply))) return reply;
    return listAgentRoles(catalogRoot);
  });
}
