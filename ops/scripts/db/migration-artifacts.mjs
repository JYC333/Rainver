// Internal companion executed in the selected server image, not a product API.
import { parseArgs } from "node:util";
import { join } from "node:path";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  home: { type: "string" }, checkout: { type: "string" }, archive: { type: "string" },
  catalog: { type: "string", multiple: true }, id: { type: "string" },
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
    const ids = await selectMigrationArchives(join(values.home, "db", "migration-archives"), values.checkout, values.catalog ?? [], applied, values.archive);
    console.log(ids.join("\n"));
  } else if (positionals[0] === "complete" && values.id) {
    await completeMigrationArchive(values.home, values.id, process.env.BACKUP_ROOT || undefined);
  } else throw new Error("Invalid archive command");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
