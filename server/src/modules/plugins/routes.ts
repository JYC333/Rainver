import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import { pluginTransitionAround } from "./settingsOperations.js";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { resolveIdentity, dbPool, sendRouteError } from "../routeUtils/common.js";
import { pluginServiceFor } from "./service.js";
import { getOfficialPlugin } from "./registry.js";
import { pluginCleanupStatuses } from "./lifecycle.js";

export function registerRoutes(app: FastifyInstance, { config }: ModuleContext): void {
  const plugin = { pluginId: "plugin_id" };
  // Retained write URLs bound to `plugin.*` (`settingsOperations.ts`). `/install` answers a
  // system command receipt; its `{ install, item }` is released by the command status read.
  registerOperationAdapters(app, config, [
    { method: "POST", url: "/api/v1/plugins/:pluginId/install", operation: "official_plugin.install", params: plugin },
    { method: "POST", url: "/api/v1/plugins/:pluginId/enable", operation: "official_plugin.enable", params: plugin, around: pluginTransitionAround(config, true) },
    { method: "POST", url: "/api/v1/plugins/:pluginId/disable", operation: "official_plugin.disable", params: plugin, around: pluginTransitionAround(config, false) },
    { method: "PATCH", url: "/api/v1/plugins/:pluginId/settings", operation: "official_plugin.settings.update", params: plugin },
  ]);
  const db = () => dbPool(config);

  /**
   * GET /api/v1/plugins
   * List all official plugin descriptors with effective state for the
   * current space/user.
   */
  app.get("/api/v1/plugins", async (request, reply) => {
    try {
      const identity = await resolveIdentity(config, request, reply);
      if (!identity) return;
      const items = await pluginServiceFor(config).listPlugins(db(), identity.spaceId, identity.userId);
      // Cleanup obligations only for plugins this person administers here (B53).
      const cleanup = await pluginCleanupStatuses(db(), config, identity.spaceId, identity.userId);
      reply.send({ items: items.map(item => ({ ...item, cleanup: cleanup.get(item.descriptor.id) ?? null })) });
    } catch (err) {
      sendRouteError(reply, err);
    }
  });

  /**
   * GET /api/v1/plugins/effective
   * Return effective plugin state map for the current space/user.
   * Used by the frontend registry overlay.
   */
  app.get("/api/v1/plugins/effective", async (request, reply) => {
    try {
      const identity = await resolveIdentity(config, request, reply);
      if (!identity) return;
      const map = await pluginServiceFor(config).getEffectiveMap(db(), identity.spaceId, identity.userId);
      reply.send({ plugins: map });
    } catch (err) {
      sendRouteError(reply, err);
    }
  });

  /**
   * GET /api/v1/plugins/:pluginId
   * Return descriptor + effective state for a single plugin.
   */
  app.get("/api/v1/plugins/:pluginId", async (request, reply) => {
    try {
      const identity = await resolveIdentity(config, request, reply);
      if (!identity) return;
      const { pluginId } = request.params as { pluginId: string };
      if (!pluginId || !getOfficialPlugin(pluginId,config)) {
        reply.code(404).send({ detail: `Plugin not found: ${pluginId}` });
        return;
      }
      const item = await pluginServiceFor(config).getPlugin(db(), pluginId, identity.spaceId, identity.userId);
      const cleanup = await pluginCleanupStatuses(db(), config, identity.spaceId, identity.userId);
      reply.send({ ...item, cleanup: cleanup.get(pluginId) ?? null });
    } catch (err) {
      sendRouteError(reply, err);
    }
  });

}
