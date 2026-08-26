import type {
  OfficialPluginDescriptor,
  OfficialPluginEffectiveState,
  OfficialPluginListItem,
  OfficialPluginEffectiveMap,
} from "@agent-space/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { getOfficialPlugin, listOfficialPlugins } from "./registry.js";
import {
  pluginRepository,
  type PluginEnablementRow,
  type PluginInstallRow,
} from "./repository.js";
import { HttpError } from "../routeUtils/common.js";

function rowToEffective(
  descriptor: OfficialPluginDescriptor,
  row: PluginEnablementRow | null,
  install: PluginInstallRow | null,
): OfficialPluginEffectiveState {
  const installed = install?.status === "active";
  if (!row) {
    return {
      plugin_id: descriptor.id,
      installed,
      install_status: install?.status ?? null,
      installed_version: install?.installed_version ?? null,
      has_row: false,
      enabled: installed && descriptor.default_enabled,
      visible: descriptor.default_visible,
      settings: { ...descriptor.settings_defaults },
    };
  }
  return {
    plugin_id: descriptor.id,
    installed,
    install_status: install?.status ?? null,
    installed_version: install?.installed_version ?? null,
    has_row: true,
    enabled: installed && row.enabled,
    visible: row.visible,
    settings: { ...descriptor.settings_defaults, ...row.settings_json },
    enabled_at: row.enabled_at?.toISOString() ?? null,
    enabled_by_user_id: row.enabled_by_user_id ?? null,
    disabled_at: row.disabled_at?.toISOString() ?? null,
    disabled_by_user_id: row.disabled_by_user_id ?? null,
    updated_at: row.updated_at?.toISOString() ?? null,
  };
}

/** Resolve the DB keys for a plugin based on its scope.
 * scope=space  → (spaceId, null)
 * scope=user   → (null, userId)
 */
function scopeKeys(
  descriptor: OfficialPluginDescriptor,
  spaceId: string,
  userId: string,
): { scopeSpaceId: string | null; scopeUserId: string | null } {
  if (descriptor.scope === "user") {
    return { scopeSpaceId: null, scopeUserId: userId };
  }
  return { scopeSpaceId: spaceId, scopeUserId: null };
}

function rowMatchesDescriptor(
  descriptor: OfficialPluginDescriptor,
  row: PluginEnablementRow,
): boolean {
  if (descriptor.scope === "user") {
    return row.space_id === null && row.user_id !== null;
  }
  return row.space_id !== null && row.user_id === null;
}

export const pluginService = {
  async listPlugins(
    db: Queryable,
    spaceId: string,
    userId: string,
  ): Promise<OfficialPluginListItem[]> {
    const descriptors = listOfficialPlugins();
    const rows = await pluginRepository.findAllForContext(db, spaceId, userId);
    const installs = await pluginRepository.findAllInstalls(db);

    return descriptors.map((d) => ({
      descriptor: d,
      effective: rowToEffective(
        d,
        rows.find((row) => row.plugin_id === d.id && rowMatchesDescriptor(d, row)) ?? null,
        installs.find((install) => install.plugin_id === d.id) ?? null,
      ),
    }));
  },

  async getEffectiveMap(
    db: Queryable,
    spaceId: string,
    userId: string,
  ): Promise<OfficialPluginEffectiveMap> {
    const items = await this.listPlugins(db, spaceId, userId);
    const map: OfficialPluginEffectiveMap = {};
    for (const item of items) {
      map[item.descriptor.id] = item.effective;
    }
    return map;
  },

  async getPlugin(
    db: Queryable,
    pluginId: string,
    spaceId: string,
    userId: string,
  ): Promise<OfficialPluginListItem> {
    const descriptor = getOfficialPlugin(pluginId);
    if (!descriptor) {
      throw new HttpError(404, `Plugin not found: ${pluginId}`);
    }
    const { scopeSpaceId, scopeUserId } = scopeKeys(descriptor, spaceId, userId);
    const row = await pluginRepository.findEnablement(db, pluginId, scopeSpaceId, scopeUserId);
    const install = await pluginRepository.findInstall(db, pluginId);
    return { descriptor, effective: rowToEffective(descriptor, row, install) };
  },

  async enablePlugin(
    db: Queryable,
    pluginId: string,
    spaceId: string,
    userId: string,
    opts: { settings?: Record<string, unknown> },
  ): Promise<OfficialPluginListItem> {
    const descriptor = getOfficialPlugin(pluginId);
    if (!descriptor) {
      throw new HttpError(404, `Plugin not found: ${pluginId}`);
    }
    const install = await pluginRepository.findInstall(db, pluginId);
    if (install?.status !== "active") {
      throw new HttpError(409, `Plugin is not installed: ${pluginId}`);
    }
    const { scopeSpaceId, scopeUserId } = scopeKeys(descriptor, spaceId, userId);
    const row = await pluginRepository.upsertEnablement(db, {
      spaceId: scopeSpaceId,
      userId: scopeUserId,
      pluginId,
      enabled: true,
      settings: opts.settings,
      actorUserId: userId,
    });
    return { descriptor, effective: rowToEffective(descriptor, row, install) };
  },

  async disablePlugin(
    db: Queryable,
    pluginId: string,
    spaceId: string,
    userId: string,
  ): Promise<OfficialPluginListItem> {
    const descriptor = getOfficialPlugin(pluginId);
    if (!descriptor) {
      throw new HttpError(404, `Plugin not found: ${pluginId}`);
    }
    const { scopeSpaceId, scopeUserId } = scopeKeys(descriptor, spaceId, userId);
    const row = await pluginRepository.upsertEnablement(db, {
      spaceId: scopeSpaceId,
      userId: scopeUserId,
      pluginId,
      enabled: false,
      actorUserId: userId,
    });
    const install = await pluginRepository.findInstall(db, pluginId);
    return { descriptor, effective: rowToEffective(descriptor, row, install) };
  },

  async patchSettings(
    db: Queryable,
    pluginId: string,
    spaceId: string,
    userId: string,
    settings: Record<string, unknown>,
  ): Promise<OfficialPluginListItem> {
    const descriptor = getOfficialPlugin(pluginId);
    if (!descriptor) {
      throw new HttpError(404, `Plugin not found: ${pluginId}`);
    }
    const { scopeSpaceId, scopeUserId } = scopeKeys(descriptor, spaceId, userId);

    const row = await pluginRepository.patchSettings(db, {
      spaceId: scopeSpaceId,
      userId: scopeUserId,
      pluginId,
      settings,
      actorUserId: userId,
    });

    if (!row) {
      const created = await pluginRepository.upsertEnablement(db, {
        spaceId: scopeSpaceId,
        userId: scopeUserId,
        pluginId,
        enabled: descriptor.default_enabled,
        settings,
        actorUserId: userId,
      });
      const install = await pluginRepository.findInstall(db, pluginId);
      return { descriptor, effective: rowToEffective(descriptor, created, install) };
    }

    const install = await pluginRepository.findInstall(db, pluginId);
    return { descriptor, effective: rowToEffective(descriptor, row, install) };
  },

  /** Check whether a plugin is enabled for the given space/user. Used by guards. */
  async isEnabled(
    db: Queryable,
    pluginId: string,
    spaceId: string,
    userId: string | null,
  ): Promise<{ exists: boolean; installed: boolean; enabled: boolean }> {
    const descriptor = getOfficialPlugin(pluginId);
    if (!descriptor) return { exists: false, installed: false, enabled: false };

    // User-scoped plugins require a concrete userId — fail closed when absent.
    if (descriptor.scope === "user" && !userId) {
      return { exists: true, installed: false, enabled: false };
    }

    const install = await pluginRepository.findInstall(db, pluginId);
    const installed = install?.status === "active";
    if (!installed) return { exists: true, installed: false, enabled: false };

    const { scopeSpaceId, scopeUserId } = scopeKeys(descriptor, spaceId, userId ?? "");
    const row = await pluginRepository.findEnablement(db, pluginId, scopeSpaceId, scopeUserId);
    if (!row) return { exists: true, installed, enabled: descriptor.default_enabled };
    return { exists: true, installed, enabled: row.enabled };
  },
};
