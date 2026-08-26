import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { PluginDisabledError } from "@rainver/protocol";
import { dbPool, resolveIdentity } from "../routeUtils/common.js";
import { pluginService } from "./service.js";

export interface PluginGuardOptions {
  pluginId: string;
  /** Space ID to check. If not provided, resolved from request identity. */
  spaceId?: string;
  /** User ID to check. If not provided, resolved from request identity. */
  userId?: string;
}

/**
 * Reusable plugin guard for backend routes.
 *
 * Checks that an official optional module is enabled for the current space/user.
 * Returns true if the plugin is enabled; returns false and sends the appropriate
 * error response if it is disabled or does not exist.
 *
 * Usage in a route handler:
 *   const allowed = await requireOfficialPluginEnabled(config, request, reply, {
 *     pluginId: "diary",
 *   });
 *   if (!allowed) return;
 *
 * The guard resolves identity from the request when spaceId/userId are not provided.
 * Fails closed: any identity/DB error → rejects the request.
 */
export async function requireOfficialPluginEnabled(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: PluginGuardOptions,
): Promise<boolean> {
  // Resolve identity if not injected
  let spaceId = opts.spaceId;
  let userId = opts.userId;

  if (!spaceId || !userId) {
    const identity = await resolveIdentity(config, request, reply);
    if (!identity) return false; // resolveIdentity already sent the error
    spaceId = spaceId ?? identity.spaceId;
    userId = userId ?? identity.userId;
  }

  const db = dbPool(config);
  const { exists, installed, enabled } = await pluginService.isEnabled(
    db,
    opts.pluginId,
    spaceId,
    userId,
  );

  if (!exists) {
    const body: PluginDisabledError = {
      detail: "Plugin not found",
      error_code: "plugin_not_found",
      plugin_id: opts.pluginId,
    };
    reply.code(404).send(body);
    return false;
  }

  if (!installed) {
    const body: PluginDisabledError = {
      detail: "Plugin is not installed",
      error_code: "plugin_not_installed",
      plugin_id: opts.pluginId,
    };
    reply.code(403).send(body);
    return false;
  }

  if (!enabled) {
    const body: PluginDisabledError = {
      detail: "Plugin is not enabled",
      error_code: "plugin_disabled",
      plugin_id: opts.pluginId,
    };
    reply.code(403).send(body);
    return false;
  }

  return true;
}
