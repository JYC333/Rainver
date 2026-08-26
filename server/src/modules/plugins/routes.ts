import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  resolveIdentity,
  dbPool,
  HttpError,
  sendRouteError,
  jsonBody,
  objectValue,
  withDbTransaction,
} from "../routeUtils/common.js";
import { requireSpaceOwnerOrAdmin, requireInstanceAdmin } from "../routeUtils/access.js";
import { pluginService } from "./service.js";
import { getOfficialPlugin } from "./registry.js";
import { installOfficialPlugin } from "./installer.js";
import { BUILT_IN_PLUGINS } from "./builtInPlugins.js";

function settingsObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "settings must be an object");
  }
  return objectValue(value);
}

async function requirePluginWritePermission(
  config: ServerConfig,
  identity: { spaceId: string; userId: string },
  pluginId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const descriptor = getOfficialPlugin(pluginId);
  if (!descriptor) {
    reply.code(404).send({ detail: `Plugin not found: ${pluginId}` });
    return false;
  }
  if (descriptor.scope === "user") return true;
  return requireSpaceOwnerOrAdmin(config, identity, reply);
}

export function registerRoutes(app: FastifyInstance, { config }: ModuleContext): void {
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
      const items = await pluginService.listPlugins(db(), identity.spaceId, identity.userId);
      reply.send({ items });
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
      const map = await pluginService.getEffectiveMap(db(), identity.spaceId, identity.userId);
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
      if (!pluginId || !getOfficialPlugin(pluginId)) {
        reply.code(404).send({ detail: `Plugin not found: ${pluginId}` });
        return;
      }
      const item = await pluginService.getPlugin(db(), pluginId, identity.spaceId, identity.userId);
      reply.send(item);
    } catch (err) {
      sendRouteError(reply, err);
    }
  });

  /**
   * POST /api/v1/plugins/:pluginId/install
   * Install an official plugin package on this instance.
   * Runs plugin-owned migrations and records plugin_installs/plugin_migrations.
   */
  app.post("/api/v1/plugins/:pluginId/install", async (request, reply) => {
    try {
      const identity = await resolveIdentity(config, request, reply);
      if (!identity) return;
      const { pluginId } = request.params as { pluginId: string };
      if (!(await requirePluginWritePermission(config, identity, pluginId, reply))) return;

      if (!(await requireInstanceAdmin(config, identity, reply, "Plugin install requires instance admin"))) return;
      const install = await withDbTransaction(
        db(),
        (client) =>
          installOfficialPlugin(client, pluginId, BUILT_IN_PLUGINS, {
            actorUserId: identity.userId,
            source: "official",
          }),
      );
      const item = await pluginService.getPlugin(db(), pluginId, identity.spaceId, identity.userId);
      reply.code(200).send({ install, item });
    } catch (err) {
      sendRouteError(reply, err);
    }
  });

  /**
   * POST /api/v1/plugins/:pluginId/enable
   * Enable a plugin. Scope (space vs user) is determined by the plugin descriptor.
   * Body: { settings?: Record<string, unknown> }
   */
  app.post("/api/v1/plugins/:pluginId/enable", async (request, reply) => {
    try {
      const identity = await resolveIdentity(config, request, reply);
      if (!identity) return;
      const { pluginId } = request.params as { pluginId: string };
      const body = jsonBody(request);
      const settings = settingsObject(body.settings);
      if (!(await requirePluginWritePermission(config, identity, pluginId, reply))) return;

      const item = await withDbTransaction(
        db(),
        (client) =>
          pluginService.enablePlugin(
            client,
            pluginId,
            identity.spaceId,
            identity.userId,
            { settings },
          ),
      );
      reply.code(200).send(item);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) {
        reply.code(404).send({ detail: err.message });
        return;
      }
      sendRouteError(reply, err);
    }
  });

  /**
   * POST /api/v1/plugins/:pluginId/disable
   * Disable a plugin. Does not delete data.
   * Scope is determined by the plugin descriptor.
   */
  app.post("/api/v1/plugins/:pluginId/disable", async (request, reply) => {
    try {
      const identity = await resolveIdentity(config, request, reply);
      if (!identity) return;
      const { pluginId } = request.params as { pluginId: string };
      if (!(await requirePluginWritePermission(config, identity, pluginId, reply))) return;

      const item = await withDbTransaction(
        db(),
        (client) =>
          pluginService.disablePlugin(
            client,
            pluginId,
            identity.spaceId,
            identity.userId,
          ),
      );
      reply.code(200).send(item);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) {
        reply.code(404).send({ detail: err.message });
        return;
      }
      sendRouteError(reply, err);
    }
  });

  /**
   * PATCH /api/v1/plugins/:pluginId/settings
   * Patch settings_json for a plugin. Allowed even when disabled (for pre-configuration).
   * Body: { settings: Record<string, unknown> }
   */
  app.patch("/api/v1/plugins/:pluginId/settings", async (request, reply) => {
    try {
      const identity = await resolveIdentity(config, request, reply);
      if (!identity) return;
      const { pluginId } = request.params as { pluginId: string };
      const body = jsonBody(request);
      if (body.settings === undefined || body.settings === null) {
        reply.code(422).send({ detail: "settings must be an object" });
        return;
      }
      const settings = settingsObject(body.settings)!;
      if (!(await requirePluginWritePermission(config, identity, pluginId, reply))) return;

      const item = await withDbTransaction(
        db(),
        (client) =>
          pluginService.patchSettings(
            client,
            pluginId,
            identity.spaceId,
            identity.userId,
            settings,
          ),
      );
      reply.code(200).send(item);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) {
        reply.code(404).send({ detail: err.message });
        return;
      }
      sendRouteError(reply, err);
    }
  });
}
