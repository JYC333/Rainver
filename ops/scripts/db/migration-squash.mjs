import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const usage = `Migration squash (no environment restriction):
  prepare --source DIR --output DIR --from 0001 --name plan_name
  convert --source DIR --target DIR [--apply --offline --backup FILE]
prepare writes a separate SQL/Drizzle chain; keep the source archive until all databases convert.
convert previews by default and uses SERVER_DATABASE_URL. Apply requires stopped writers and a pg_dump -Fc backup.
Only a terminal, unpublished suffix may be squashed; never the baseline or a released migration.`;

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
  const { convertMigrationHistory } = await import("../../../server/dist/db/migrationConversion.js");
  const pool = getDbPool(process.env.SERVER_DATABASE_URL);
  try {
    const result = await convertMigrationHistory(pool, values.source, values.target, {
      apply: values.apply, offline: values.offline,
      backupReference: values.backup ? resolve(values.backup) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await pool.end(); }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
