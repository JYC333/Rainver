import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage = `Migration squash (no environment restriction):
  prepare --source DIR --output DIR --from 0001 --name plan_name
  convert --source DIR --target DIR [--apply --offline --backup FILE]
Use the same commands with a bundled plugin migrations directory or prepared archive.
prepare writes a separate SQL/Drizzle chain; keep the source archive until all databases convert.
convert previews by default and uses SERVER_DATABASE_URL. Apply requires stopped writers and a pg_dump -Fc backup.
Only a terminal, unpublished suffix may be squashed. Keep the core baseline and released migrations.`;

async function main() {
  const { values, positionals } = parseArgs({ options: {
    source: { type: "string" }, output: { type: "string" }, from: { type: "string" }, name: { type: "string" },
    target: { type: "string" }, apply: { type: "boolean" }, offline: { type: "boolean" }, backup: { type: "string" },
    help: { type: "boolean", short: "h" }, home: { type: "string" },
  }, allowPositionals: true });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1 || !values.source) throw new Error(usage);
  if (positionals[0] === "prepare" && values.from && values.name) {
    if (values.apply || values.offline || values.backup || values.target) throw new Error(usage);
    const officialRoot = fileURLToPath(new URL("../../../plugins/official/", import.meta.url));
    const [plugin, directory, ...rest] = relative(officialRoot, resolve(values.source)).split(sep);
    if (directory === "migrations" && rest.length === 0 && /^[a-z][a-z0-9_]{0,23}$/.test(plugin)) {
      if (!/^\d{4}$/.test(values.from) || !/^[a-z][a-z0-9_]*$/.test(values.name)) throw new Error("Invalid migration version or name");
      if (!values.output && !values.home) throw new Error("An instance home or --output directory is required");
      const { preparePluginSquashArchive } = await import("../../../server/dist/db/migrationSquash.js");
      const archive = values.output ?? join(values.home, "db", "plugin-migration-archives", `${plugin}-${values.from}_${values.name}`);
      preparePluginSquashArchive(values.source, archive, values.from, values.name);
      console.log(archive);
      return;
    }
    if (values.output) {
      const { prepareSquash } = await import("../../../server/dist/db/migrationSquash.js");
      prepareSquash(values.source, values.output, values.from, values.name);
      console.log("Prepared separate merged migration directory; source unchanged.");
    } else {
      if (!values.home) throw new Error("An instance home is required for managed preparation");
      const { prepareManagedMigrationArchive } = await import("../../../server/dist/db/migrationArtifacts.js");
      console.log(await prepareManagedMigrationArchive(values.home, values.source, values.from, values.name));
    }
    return;
  }
  if (positionals[0] !== "convert" || !values.target || values.output || values.from || values.name) throw new Error(usage);
  if (!process.env.SERVER_DATABASE_URL) throw new Error("SERVER_DATABASE_URL is required");
  if (values.apply) {
    if (!values.offline || !values.backup) throw new Error("Apply requires --offline and --backup FILE");
    if (!statSync(values.backup).isFile() || statSync(values.backup).size <= 5) throw new Error("Backup must be a nonempty pg_dump custom archive");
    const fd = openSync(values.backup, "r");
    try {
      const header = Buffer.alloc(5);
      readSync(fd, header, 0, 5, 0);
      if (header.toString() !== "PGDMP") throw new Error("Backup must be a pg_dump -Fc archive");
    } finally { closeSync(fd); }
  }
  const { getDbPool } = await import("../../../server/dist/db/pool.js");
  const pool = getDbPool(process.env.SERVER_DATABASE_URL);
  try {
    const options = {
      apply: values.apply, offline: values.offline,
      backupReference: values.backup ? resolve(values.backup) : undefined,
    };
    const { loadMigrations } = await import("../../../server/dist/db/migrator.js");
    const { isMergedPluginMigration } = await import("../../../server/dist/modules/plugins/migrationSql.js");
    const target = loadMigrations(values.target);
    if (target.some(({ sql }) => isMergedPluginMigration(sql))) {
      const { BUILT_IN_PLUGINS } = await import("../../../server/dist/modules/plugins/builtInPlugins.js");
      const { convertPluginMigrationHistory } = await import("../../../server/dist/modules/plugins/migrationConversion.js");
      const plugins = BUILT_IN_PLUGINS.filter(({ migrations }) => migrations?.length === target.length &&
        target.every(({ version, name, sql }, index) => migrations[index].id === `${version}_${name}` && migrations[index].sql === sql));
      if (plugins.length !== 1) throw new Error("Target migration chain must match exactly one bundled plugin in the selected image");
      console.log(JSON.stringify(await convertPluginMigrationHistory(pool, plugins[0], values.source, values.target, options), null, 2));
      return;
    }
    const { convertMigrationHistory } = await import("../../../server/dist/db/migrationConversion.js");
    const result = await convertMigrationHistory(pool, values.source, values.target, options);
    console.log(JSON.stringify(result, null, 2));
  } finally { await pool.end(); }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
