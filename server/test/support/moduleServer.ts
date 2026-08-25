import type { FastifyInstance } from "fastify";
import { createConfigSnapshot, type ServerConfig } from "../../src/config";
import {
  createServerApp,
  registerGatewayConventions,
  registerUnknownApiRoute,
  type ServerAppOptions,
} from "../../src/gateway/appShell";
// Type-only: the registry's value import would load every module.
import type { ModuleContext, ServerModule } from "../../src/gateway/routeRegistry";

/**
 * The server's app shell with only the given modules' routes on it.
 *
 * Route tests used to call `buildServer`, which registers all ~70 modules and
 * therefore loads the whole backend graph per test file — measured at ~6s of
 * module collection for each such file, several times the tests themselves.
 * The gateway conventions, body handling, and catch-all are the real ones, so
 * status codes and envelopes are the same as through `buildServer`; only
 * routes from other modules are absent, and a request to one is a 404 here.
 *
 * Use `buildServer` itself when the test is about the gateway or registry.
 */
export function buildModuleServer(
  config: ServerConfig,
  modules: readonly ServerModule[],
  options: ServerAppOptions = { logger: false },
): FastifyInstance {
  const app = createServerApp(config, options);
  registerGatewayConventions(app);
  const context: ModuleContext = { config, snapshot: createConfigSnapshot(config) };
  for (const module of modules) module.registerRoutes(app, context);
  registerUnknownApiRoute(app);
  return app;
}
