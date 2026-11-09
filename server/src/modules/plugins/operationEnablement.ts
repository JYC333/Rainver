import { operationPackageIdentity } from './packageIdentity.js';
import type { ServerConfig } from "../../config.js";
import type { Queryable } from '../routeUtils/common.js';
import { operationPackages, pluginOperations } from './operationRegistry.js';
import { getOfficialPlugin } from './registry.js';
import { pluginServiceFor } from './service.js';
/** Same canonical guard source, plus manifest/runtime version eligibility for new operations. */
export async function operationPluginEnabled(db: Queryable, id: string, space: string, user: string, config?: ServerConfig): Promise<boolean> {
  if (id.startsWith('plugin.')) return false;
  if (operationPackages(config).some(p => p.id === id) && !pluginOperations(config).some(r => r.definition.owning_module === `plugin.${id}`)) return false;
  const descriptor = getOfficialPlugin(id, config);
  if (!descriptor) return false;
  const {
    enabled
  } = await pluginServiceFor(config).isEnabled(db, id, space, user);
  if (!enabled) return false;
  const row = (await db.query<{
    installed_version: string;
    lifecycle_state: string;
    manifest_json: Record<string, unknown>;
  }>('SELECT installed_version,lifecycle_state,manifest_json FROM plugin_installs WHERE plugin_id=$1', [id])).rows[0];
  const runtime = operationPackages(config).find(p => p.id === id);
  if (runtime && (row?.manifest_json?.operation_api !== 1 || row.manifest_json.operation_contract !== operationPackageIdentity(runtime))) return false;
  return row?.installed_version === descriptor.version && row.lifecycle_state === 'installed' && (await pluginDependenciesEnabled(db, id, space, user, config));
}
export function dependencyIds(id: string, config?: ServerConfig): string[] {
  const map = new Map(operationPackages(config).map(p => [p.id, p]));
  const seen = new Set<string>();
  function walk(key: string) {
    if (seen.has(key)) return;
    seen.add(key);
    for (const dep of map.get(key)?.operationManifest?.requires ?? []) walk(dep);
  }
  walk(id);
  return [...seen].sort();
}
export async function pluginDependenciesEnabled(db: Queryable, id: string, space: string, user: string, config?: ServerConfig): Promise<boolean> {
  for (const dep of dependencyIds(id, config).filter(x => x !== id)) {
    const descriptor = getOfficialPlugin(dep, config);
    if (!descriptor) return false;
    const state = await pluginServiceFor(config).isEnabled(db, dep, space, user);
    if (!state.enabled) return false;
    const install = (await db.query<{
      installed_version: string;
      lifecycle_state: string;
      manifest_json: Record<string, unknown>;
    }>('SELECT installed_version,lifecycle_state,manifest_json FROM plugin_installs WHERE plugin_id=$1', [dep])).rows[0];
    if (install?.installed_version !== descriptor.version || install.lifecycle_state !== 'installed') return false;
    const runtime = operationPackages(config).find(p => p.id === dep);
    if (runtime && (install.manifest_json?.operation_api !== 1 || install.manifest_json.operation_contract !== operationPackageIdentity(runtime))) return false;
  }
  return true;
}
export async function lockOperationPluginScope(db: Queryable, id: string, space: string, user: string, config?: ServerConfig, write = false) {
  const ids = dependencyIds(id, config),
    lock = write ? 'UPDATE' : 'SHARE';
  await db.query(`SELECT id FROM plugin_installs WHERE plugin_id=ANY($1::text[]) ORDER BY plugin_id FOR ${lock}`, [ids]);
  await db.query(`SELECT id FROM official_plugin_enablements WHERE plugin_id=ANY($1::text[]) AND (space_id=$2 OR user_id=$3) ORDER BY plugin_id,id FOR ${lock}`, [ids, space, user]);
}
