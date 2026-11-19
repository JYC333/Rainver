import type { ServerConfig } from "../../config.js";
import type { Queryable } from '../routeUtils/common.js';
import { operationPackageFacts, operationPackages, pluginOperations } from './operationRegistry.js';
import { getOfficialPlugin } from './registry.js';
import { pluginServiceFor } from './service.js';
/** Same canonical guard source, plus manifest/runtime version eligibility for new operations. */
export async function operationPluginEnabled(db: Queryable, id: string, space: string, user: string, config?: ServerConfig): Promise<boolean> {
  if (id.startsWith('plugin.')) return false;
  if (operationPackages(config).some(p => p.id === id) && !pluginOperations(config).some(r => r.definition.owning_module === `plugin.${id}`)) return false;
  return await packageEnabledNow(db, id, space, user, config) && await pluginDependenciesEnabled(db, id, space, user, config);
}
/**
 * One package's live eligibility, identical for the package itself and each
 * dependency: a descriptor, its enablement for this scope, and an installed row
 * at the descriptor's version whose admitted operation contract is this
 * runtime package's (cached identity, never a cached DB answer).
 */
async function packageEnabledNow(db: Queryable, id: string, space: string, user: string, config?: ServerConfig): Promise<boolean> {
  const descriptor = getOfficialPlugin(id, config);
  if (!descriptor || !(await pluginServiceFor(config).isEnabled(db, id, space, user)).enabled) return false;
  const row = (await db.query<{
    installed_version: string;
    lifecycle_state: string;
    manifest_json: Record<string, unknown>;
  }>('SELECT installed_version,lifecycle_state,manifest_json FROM plugin_installs WHERE plugin_id=$1', [id])).rows[0];
  if (row?.installed_version !== descriptor.version || row.lifecycle_state !== 'installed') return false;
  const runtime = operationPackageFacts(config, id);
  return !runtime || row.manifest_json?.operation_api === 1 && row.manifest_json.operation_contract === runtime.identity;
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
  for (const dep of dependencyIds(id, config).filter(x => x !== id)) if (!(await packageEnabledNow(db, dep, space, user, config))) return false;
  return true;
}
export async function lockOperationPluginScope(db: Queryable, id: string, space: string, user: string, config?: ServerConfig, write = false) {
  const ids = dependencyIds(id, config),
    lock = write ? 'UPDATE' : 'SHARE';
  await db.query(`SELECT id FROM plugin_installs WHERE plugin_id=ANY($1::text[]) ORDER BY plugin_id FOR ${lock}`, [ids]);
  await db.query(`SELECT id FROM official_plugin_enablements WHERE plugin_id=ANY($1::text[]) AND (space_id=$2 OR user_id=$3) ORDER BY plugin_id,id FOR ${lock}`, [ids, space, user]);
}
