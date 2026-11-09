import { operationPackageIdentity } from './packageIdentity.js';
import { createHash } from 'node:crypto';
import type { Pool } from '../../db/pool.js';
import { BUILT_IN_PLUGINS } from './builtInPlugins.js';
import { migrateOperationPlugins, reconcileOperationPlugins } from './operationMigrations.js';
import { pluginRepository } from './repository.js';
export async function operationPluginsPending(pool: Pool): Promise<string[]> {
  const pending: string[] = [];
  const known = new Set(BUILT_IN_PLUGINS.filter(p => p.operationManifest).map(p => p.id));
  const exists = !!(await pool.query<{
    name: string | null;
  }>("SELECT to_regclass('public.plugin_installs') AS name")).rows[0]?.name;
  for (const p of BUILT_IN_PLUGINS) {
    if (!p.operationManifest) continue;
    const row = exists ? await pluginRepository.findInstall(pool, p.id) : null;
    if (!row || row.installed_version !== p.version || row.lifecycle_state !== 'installed' || row.manifest_json.operation_api !== 1 || row.manifest_json.operation_contract !== operationPackageIdentity(p)) pending.push(`plugin:${p.id}@${p.version}`);else for (const m of p.migrations ?? []) {
      const applied = await pluginRepository.findMigration(pool, p.id, m.id);
      if (applied?.status !== 'applied' || applied.checksum !== createHash('sha256').update(m.sql).digest('hex')) pending.push(`plugin:${p.id}/${m.id}`);
    }
  }
  if (exists) for (const row of await pluginRepository.findAllInstalls(pool)) if (row.manifest_json?.operation_api === 1 && !known.has(row.plugin_id)) pending.push(`plugin:${row.plugin_id}:package-missing`);
  return pending;
}
export async function offlineOperationPlugins(pool: Pool, command: 'migrate' | 'reconcile', repairFailed = false) {
  const known = new Set(BUILT_IN_PLUGINS.filter(p => p.operationManifest).map(p => p.id));
  for (const row of await pluginRepository.findAllInstalls(pool)) if (row.manifest_json?.operation_api === 1 && !known.has(row.plugin_id)) throw new Error('Installed operation package missing from this image; restore/migrate requires its matching package');
  if (command === 'migrate') await migrateOperationPlugins(pool, BUILT_IN_PLUGINS, {
    repairFailed
  });
  await reconcileOperationPlugins(pool, BUILT_IN_PLUGINS);
}
