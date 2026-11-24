import type { RainverPlugin } from "@rainver/protocol";
import { createHash } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import { loadSquashPlan } from "../../db/migrationSquash.js";
import { applyOperationMigrationSql, originalPluginMigrations, type PluginMigrationSql } from "./migrationSql.js";
import { operationPackageIdentity } from "./packageIdentity.js";
import { getOfficialPlugin } from "./registry.js";
import { pluginRepository } from "./repository.js";
import { reconcilePluginRole } from "./roleReconcile.js";

const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");

interface JournalRow {
  migration_id: string;
  checksum: string | null;
  status: string;
  plugin_version: string;
  applied_at: string;
}

interface ConversionOptions {
  apply?: boolean;
  offline?: boolean;
  backupReference?: string;
  requireInstalled?: boolean;
}

/** Expand only the bundled migrations whose older history the journal still carries. */
function findSource(target: readonly PluginMigrationSql[], rows: readonly JournalRow[]) {
  let index = 0;
  const match = (step: PluginMigrationSql): PluginMigrationSql[] => {
    const next = rows[index];
    if (!next) return [step];
    if (next.migration_id === step.id && next.status === "applied" && next.checksum === checksum(step.sql)) {
      index++;
      return [step];
    }
    const earlier = originalPluginMigrations(step.sql);
    if (earlier) return earlier.flatMap(match);
    throw new Error("Plugin migration history is not an exact applied prefix of the bundled source");
  };
  const groups = target.map((migration) => ({ migration, original: match(migration) }));
  if (index !== rows.length) throw new Error("Plugin migration history is not an exact applied prefix of the bundled source");
  return groups;
}

/** The old SQL is embedded in the trusted image and retains the exact original IDs. */
export async function convertBundledPluginMigrationHistory(pool: Pool, plugin: RainverPlugin, options: ConversionOptions = {}) {
  if (!plugin.operationManifest || getOfficialPlugin(plugin.id)) throw new Error("Expected a bundled operation plugin");
  if (options.apply && (!options.offline || !options.backupReference?.trim())) {
    throw new Error("Apply requires stopped writers (--offline) and a backup reference");
  }
  const bundled = plugin.migrations ?? [];
  const declared = plugin.operationManifest.migrations ?? [];
  if (plugin.operationManifest.id !== plugin.id || plugin.operationManifest.version !== plugin.version ||
      bundled.length !== declared.length || bundled.some(({ id }, index) => declared[index] !== id)) {
    throw new Error("Invalid bundled plugin migration chain");
  }
  const contract = operationPackageIdentity(plugin);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('lock_timeout','3000ms',true)");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`plugin-install:${plugin.id}`]);
    const installed = await pluginRepository.findInstall(client, plugin.id);
    const { rows } = await client.query<JournalRow>(`SELECT migration_id, plugin_version, checksum, status, applied_at::text
      FROM public.plugin_migrations WHERE plugin_id=$1 ORDER BY migration_id`, [plugin.id]);
    if (!installed && !options.requireInstalled && rows.length === 0) {
      await client.query("ROLLBACK");
      return { state: "uninstalled", plugin: plugin.id, pending: [] } as const;
    }
    if (!installed || installed.source !== "official" || installed.lifecycle_state !== "installed" || installed.status === "removed" ||
        installed.manifest_json.operation_api !== 1) throw new Error("Plugin must already be installed and healthy; fresh databases use migrate up");
    const groups = findSource(bundled, rows);
    const replacements = groups.filter(({ original }) => original.length > 1);
    if (!replacements.length) {
      await client.query("ROLLBACK");
      return { state: "already_target", plugin: plugin.id, pending: [] } as const;
    }
    const source = groups.flatMap(({ original }) => original);
    const pending = source.slice(rows.length);
    const pendingIds = pending.map(({ id }) => id);
    if (!options.apply) {
      await client.query("ROLLBACK");
      return { state: "preview", plugin: plugin.id, pending: pendingIds } as const;
    }
    if (pending.length) await reconcilePluginRole(client, plugin.id);
    const appliedAt = new Map(rows.map((row) => [row.migration_id, row.applied_at]));
    let previous = source[rows.length - 1]?.id;
    for (const migration of pending) {
      await applyOperationMigrationSql(client, plugin.id, migration.sql, previous);
      await pluginRepository.insertAppliedMigration(client, {
        pluginId: plugin.id, pluginVersion: plugin.version, migrationId: migration.id, checksum: checksum(migration.sql),
      });
      previous = migration.id;
    }
    await reconcilePluginRole(client, plugin.id);
    for (const { migration, original } of replacements) {
      await client.query("DELETE FROM public.plugin_migrations WHERE plugin_id=$1 AND migration_id=ANY($2::text[])", [plugin.id, original.map(({ id }) => id)]);
      await pluginRepository.insertAppliedMigration(client, {
        pluginId: plugin.id, pluginVersion: plugin.version, migrationId: migration.id,
        checksum: checksum(migration.sql), appliedAt: appliedAt.get(original.at(-1)!.id),
      });
    }
    await client.query(`UPDATE public.plugin_installs SET installed_version=$2, manifest_json=$3::jsonb WHERE plugin_id=$1`, [plugin.id, plugin.version, JSON.stringify({
      ...installed.manifest_json, id: plugin.id, version: plugin.version, operation_api: 1, operation_contract: contract,
    })]);
    const identity = (chain: readonly PluginMigrationSql[]) => chain.map(({ id, sql }) => ({ id, checksum: checksum(sql) }));
    const manifest = { source: identity(source), target: identity(bundled) };
    await client.query(`INSERT INTO public.official_plugin_events (id,plugin_id,event_type,metadata_json,created_at)
      VALUES (gen_random_uuid(),$1,'migration_squashed',$2::jsonb,now())`, [plugin.id, JSON.stringify({
      conversion: checksum(JSON.stringify(manifest)), backup_reference: options.backupReference, source_records: rows, manifest, catchup: pendingIds,
    })]);
    await client.query("COMMIT");
    return { state: "converted", plugin: plugin.id, pending: pendingIds } as const;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function convertPluginMigrationHistory(pool: Pool, plugin: RainverPlugin, sourceDir: string, targetDir: string, options: ConversionOptions = {}) {
  const plan = loadSquashPlan(sourceDir, targetDir, "plugin");
  const bundled = plugin.migrations ?? [];
  if (plan.target.length !== bundled.length || plan.target.some(({ version, name, sql }, index) =>
    bundled[index].id !== `${version}_${name}` || bundled[index].sql !== sql)) {
    throw new Error("Archived target does not match the selected image's bundled plugin migration chain");
  }
  return convertBundledPluginMigrationHistory(pool, plugin, { ...options, requireInstalled: true });
}
