import { getOfficialPlugin } from './registry.js';
import { operationPackageIdentity } from './packageIdentity.js';
import { createHash } from 'node:crypto';
import type { Pool } from '../../db/pool.js';
import { PluginOperationManifestSchema, type RainverPlugin } from '@rainver/protocol';
import { pluginOrder } from './dependencies.js';
import { pluginRoleNames, provisionPluginRoles, reconcilePluginRole } from './roleReconcile.js';
import { pluginRepository } from './repository.js';
import { operationSqlCode } from '../../db/operationSql.js';
import { HttpError } from '../routeUtils/common.js';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
/** Explicit offline transaction owner. Session lock spans rollback/failure journal; xact lock protects DDL. */
export async function migrateOperationPlugin(pool: Pool, plugin: RainverPlugin, options: {
  actorUserId?: string | null;
  repairFailed?: boolean;
  lockTimeoutMs?: number;
} = {}): Promise<void> {
  if (getOfficialPlugin(plugin.id)) throw new Error('Legacy plugin ids require their separately reviewed migration path');
  const m = PluginOperationManifestSchema.parse(plugin.operationManifest);
  if (m.id !== plugin.id || m.version !== plugin.version) throw new Error('Plugin manifest/runtime mismatch');
  const declared = m.migrations ?? [],
    actual = plugin.migrations ?? [];
  if (declared.length !== actual.length || actual.some((x, index) => declared[index] !== x.id) || new Set(declared).size !== declared.length) throw new Error('Migration declarations/order mismatch');
  const client = await pool.connect();
  let locked = false;
  let phase: 'install' | 'provision' | 'migration' | 'reconcile' | 'finalize' = 'install';
  let current: string | null = null;
  let failure: unknown;
  try {
    locked = (await client.query<{
      locked: boolean;
    }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [`plugin-install:${plugin.id}`])).rows[0]!.locked;
    if (!locked) throw new HttpError(409, 'Plugin migration is busy');
    // Admission under the install session lock is not a failed migration.
    // Preserve the existing journal and error summary when repair is required.
    const prior = await pluginRepository.findInstall(client, plugin.id);
    if (prior?.lifecycle_state === 'migration_error' && !options.repairFailed) throw new HttpError(409, 'Plugin requires explicit offline repair');
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('lock_timeout',$1,true)", [`${options.lockTimeoutMs ?? 3000}ms`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`plugin-install:${plugin.id}`]);
      await pluginRepository.upsertInstall(client, {
        pluginId: plugin.id,
        installedVersion: plugin.version,
        actorUserId: options.actorUserId ?? null,
        source: 'official',
        manifest: {
          id: plugin.id,
          version: plugin.version,
          operation_api: 1,
          operation_contract: operationPackageIdentity(plugin)
        }
      });
      await client.query("UPDATE plugin_installs SET status='disabled',lifecycle_state='installing',lifecycle_error=NULL WHERE plugin_id=$1", [plugin.id]);
      phase = 'provision';
      if (prior) await reconcilePluginRole(client, plugin.id);else await provisionPluginRoles(client, plugin.id);
      const {
        ddl,
        schema
      } = pluginRoleNames(plugin.id);
      for (const migration of actual) {
        phase = 'migration';
        current = migration.id;
        const checksum = digest(migration.sql),
          existing = await pluginRepository.findMigration(client, plugin.id, current);
        if (existing?.status === 'applied') {
          if (existing.checksum !== checksum) throw new HttpError(409, 'Plugin migration checksum mismatch');
          continue;
        }
        if (existing?.status === 'failed' && !options.repairFailed) throw new HttpError(409, 'Plugin requires explicit offline repair');
        await client.query(`SET LOCAL ROLE ${ddl}`);
        await client.query(`SET LOCAL search_path=${schema},pg_temp`);
        for (const statement of migration.sql.split('--> statement-breakpoint')) {
          if (!statement.trim()) continue;
          const code = operationSqlCode(statement);
          if (code.includes(';') || /\b(?:temp|temporary)\b/i.test(code) || !/^(create|alter|drop|comment|insert|update|delete)\b/i.test(code) || /\bset_config\b/i.test(code)) throw new Error('Migration transaction/session control refused');
          await client.query(statement);
        }
        const role = (await client.query<{
          role: string;
        }>('SELECT current_user AS role')).rows[0]!.role;
        if (role !== ddl) throw new Error('Migration role tripwire');
        await client.query('SET LOCAL ROLE NONE');
        await client.query('SET LOCAL search_path=public');
        if (existing) await client.query('DELETE FROM plugin_migrations WHERE plugin_id=$1 AND migration_id=$2 AND status=\'failed\'', [plugin.id, current]);
        await pluginRepository.insertAppliedMigration(client, {
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          migrationId: current,
          checksum
        });
      }
      current = null;
      phase = 'reconcile';
      await client.query("UPDATE plugin_installs SET lifecycle_state='migrated' WHERE plugin_id=$1", [plugin.id]);
      await reconcilePluginRole(client, plugin.id);
      phase = 'finalize';
      await client.query("UPDATE plugin_installs SET status='active',lifecycle_state='installed',lifecycle_error=NULL WHERE plugin_id=$1", [plugin.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      failure = error;
      // New independent transaction on the reserved connection: no pool-capacity deadlock after rollback.
      await client.query('BEGIN');
      try {
        await pluginRepository.upsertInstall(client, {
          pluginId: plugin.id,
          installedVersion: plugin.version,
          actorUserId: options.actorUserId ?? null,
          source: 'official',
          manifest: {
            id: plugin.id,
            version: plugin.version,
            operation_api: 1,
            operation_contract: operationPackageIdentity(plugin)
          }
        });
        const code = String((error as {
          code?: string;
        }).code ?? 'migration_failed');
        await client.query("UPDATE plugin_installs SET status='disabled',lifecycle_state='migration_error',lifecycle_error=$2 WHERE plugin_id=$1", [plugin.id, code]);
        if (current !== null) await client.query("INSERT INTO plugin_migrations(plugin_id,plugin_version,migration_id,checksum,status,error_message) VALUES($1,$2,$3,$4,'failed',$5) ON CONFLICT(migration_id,plugin_id) DO UPDATE SET status='failed',error_message=EXCLUDED.error_message WHERE plugin_migrations.status='failed'", [plugin.id, plugin.version, current, digest(actual.find(x => x.id === current)?.sql ?? ''), code]);
        await client.query("INSERT INTO official_plugin_events(id,plugin_id,event_type,actor_user_id,metadata_json,created_at) VALUES(gen_random_uuid(),$1,'migration_failed',$2,$3::jsonb,now())", [plugin.id, options.actorUserId ?? null, JSON.stringify({
          phase,
          migration_id: current,
          error_code: code
        })]);
        await client.query('COMMIT');
      } catch (journalError) {
        await client.query('ROLLBACK').catch(() => {});
        throw journalError;
      }
    }
  } finally {
    let discard = false;
    if (locked) try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`plugin-install:${plugin.id}`]);
    } catch {
      discard = true;
    }
    client.release(discard);
  }
  if (failure) throw failure;
}
export async function migrateOperationPlugins(pool: Pool, plugins: readonly RainverPlugin[], options: Parameters<typeof migrateOperationPlugin>[2] = {}): Promise<void> {
  const {
    ordered,
    pending
  } = pluginOrder(plugins);
  if (pending.length) throw new Error('Plugin dependencies missing');
  for (const plugin of ordered) {
    if (!plugin.operationManifest) continue;
    for (const dep of plugin.operationManifest.requires) {
      const row = await pluginRepository.findInstall(pool, dep);
      if (row?.status !== 'active') throw new Error('Plugin dependency not installed');
    }
    await migrateOperationPlugin(pool, plugin, options);
  }
}
export async function reconcileOperationPlugins(pool: Pool, plugins: readonly RainverPlugin[]): Promise<void> {
  for (const p of plugins) {
    if (!p.operationManifest) continue;
    if (getOfficialPlugin(p.id)) throw new Error('Legacy package reconcile is not authorized by the operation lifecycle');
    const row = await pluginRepository.findInstall(pool, p.id);
    if (!row) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('lock_timeout','3000ms',true)");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`plugin-install:${p.id}`]);
      await reconcilePluginRole(client, p.id);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
