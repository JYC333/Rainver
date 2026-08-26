/**
 * Composition root: builds the Fastify instance for the server.
 *
 * No business route logic lives here. The instance and gateway conventions
 * come from `gateway/appShell`, and all route registration is owned by
 * `gateway/routeRegistry`.
 */

import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { createServerApp, type ServerAppOptions } from "./gateway/appShell.js";
import { registerServerRoutes } from "./gateway/routeRegistry.js";
import type { PluginHost } from "./modules/plugins/host/index.js";

export interface BuildServerOptions extends ServerAppOptions {
  /** Optional plugin host — activates built-in plugins after SERVER_MODULES. */
  pluginHost?: PluginHost;
}

export function buildServer(
  config: ServerConfig,
  options: BuildServerOptions = {},
): FastifyInstance {
  const app = createServerApp(config, options);
  registerServerRoutes(app, config, options.pluginHost);
  return app;
}
