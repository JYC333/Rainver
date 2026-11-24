// Internal companion executed in the selected server image, not a product API.
import { parseArgs } from "node:util";
import { join } from "node:path";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  home: { type: "string" }, checkout: { type: "string" }, archive: { type: "string" },
  catalog: { type: "string", multiple: true }, id: { type: "string" }, backup: { type: "string" },
} });
try {
  const { selectMigrationArchives, completeMigrationArchive } = await import("../../../server/dist/db/migrationArtifacts.js");
  if (!values.home || positionals.length !== 1) throw new Error("home and one command required");
  if (positionals[0] === "select" && values.checkout) {
    // Pairs are chosen for this database's applied history; read-only, and
    // conversion rechecks it under the migration lock.
    if (!process.env.SERVER_DATABASE_URL) throw new Error("SERVER_DATABASE_URL is required");
    const { getDbPool } = await import("../../../server/dist/db/pool.js");
    const pool = getDbPool(process.env.SERVER_DATABASE_URL);
    let applied;
    try {
      applied = (await pool.query("SELECT version, name, checksum FROM public.server_schema_migrations ORDER BY version")).rows;
    } finally { await pool.end(); }
    const ids = await selectMigrationArchives(join(values.home, "db", "migration-archives"), values.checkout, values.catalog ?? [], applied, values.archive, true);
    console.log(ids.join("\n"));
  } else if (positionals[0] === "complete" && values.id) {
    await completeMigrationArchive(values.home, values.id, process.env.BACKUP_ROOT || undefined);
  } else if (["preview-plugins", "apply-plugins", "apply-core"].includes(positionals[0])) {
    const apply = positionals[0] !== "preview-plugins";
    if (apply && !values.backup) throw new Error("Cutover apply requires its verified backup reference");
    if (!process.env.SERVER_DATABASE_URL) throw new Error("SERVER_DATABASE_URL is required");
    const { getDbPool } = await import("../../../server/dist/db/pool.js");
    const pool = getDbPool(process.env.SERVER_DATABASE_URL);
    try {
      if (positionals[0] === "apply-core") {
        const { migrateCore } = await import("../../../server/dist/db/migrateUp.js");
        const { DEFAULT_APP_ROLE } = await import("../../../server/dist/db/runtimeRoles.js");
        await migrateCore(pool, "/app/server/migrations", process.env.RAINVER_DB_APP_ROLE?.trim() || DEFAULT_APP_ROLE, console.log);
      } else {
        const { BUILT_IN_PLUGINS } = await import("../../../server/dist/modules/plugins/builtInPlugins.js");
        const { isMergedPluginMigration } = await import("../../../server/dist/modules/plugins/migrationSql.js");
        const { convertBundledPluginMigrationHistory } = await import("../../../server/dist/modules/plugins/migrationConversion.js");
        const { pluginOrder } = await import("../../../server/dist/modules/plugins/dependencies.js");
        const { ordered, pending } = pluginOrder(BUILT_IN_PLUGINS);
        if (pending.length) throw new Error("Plugin dependencies missing from target image");
        let conversions = 0;
        for (const plugin of ordered) {
          if (!plugin.migrations?.some(({ sql }) => isMergedPluginMigration(sql))) continue;
          const result = await convertBundledPluginMigrationHistory(pool, plugin, { apply, offline: apply, backupReference: values.backup });
          if (result.state === "preview") conversions++;
          if (result.state === "preview" || result.state === "converted") {
            console.error(`${plugin.id}: ${result.state}, ${result.pending.length} migration(s) to catch up`);
          }
        }
        if (!apply) console.log(conversions);
      }
    } finally { await pool.end(); }
  } else throw new Error("Invalid archive command");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
