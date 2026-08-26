/**
 * Provider routes.
 *
 * - GET /api/v1/providers
 * - GET /api/v1/providers/presets
 * - GET /api/v1/providers/vendors
 * - GET /api/v1/providers/:configId
 *
 * Provider reads and commands are server-owned. List/detail read from the provider
 * DB port behind native server identity; the vendor registry and preset catalog
 * are server-owned constants.
 *
 * The static sub-routes must be claimed explicitly: once this module owns
 * `GET /api/v1/providers/:configId`, the parametric route would otherwise
 * swallow `/presets` and `/vendors` (parametric beats the fallback
 * proxy wildcard) and mis-validate their non-DTO payloads as provider configs.
 *
 * Provider commands and credential-channel routes are registered by
 * provider command routes.
 */

import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  getProviderConfig,
  listProviderVendorCatalog,
  listProviderConfigs,
  listProviderPresets,
} from "./service.js";
import { registerProviderCommandRoutes } from "./commands/routes.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerProviderCommandRoutes(app, context.config);
  app.get("/api/v1/providers", async (request, reply) =>
    listProviderConfigs(context.config, request, reply),
  );
  app.get("/api/v1/providers/presets", async (request, reply) =>
    listProviderPresets(context.config, request, reply),
  );
  app.get("/api/v1/providers/vendors", async (request, reply) =>
    listProviderVendorCatalog(context.config, request, reply),
  );
  app.get("/api/v1/providers/:configId", async (request, reply) =>
    getProviderConfig(context.config, request, reply),
  );
}
