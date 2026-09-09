/**
 * CLI entry for the server migration runner: `node dist/db/migrateCli.js [up|status]`.
 *
 * Schema migrations are explicit ops commands, not server-startup side effects.
 * Run from `server/` so the default migrations directory resolves, or set
 * `SERVER_MIGRATIONS_DIR`.
 */

import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { getDbPool } from "./pool.js";
import { migrate, status } from "./migrator.js";

function migrationsDir(): string {
  const override = process.env.SERVER_MIGRATIONS_DIR?.trim();
  if (override) return resolve(override);
  // dist/db/migrateCli.js -> server/migrations
  return resolve(import.meta.dirname, "..", "..", "migrations");
}

async function main(): Promise<void> {
  const command = (process.argv[2] ?? "up").toLowerCase();
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error("SERVER_DATABASE_URL is required to run migrations");
    process.exitCode = 2;
    return;
  }
  const pool = getDbPool(config.databaseUrl);
  const dir = migrationsDir();
  try {
    if (command === "status") {
      const rows = await status(pool, dir);
      for (const r of rows) {
        console.log(`${r.applied ? "[x]" : "[ ]"} ${r.version}_${r.name}${r.maintenance ? " (maintenance)" : ""}`);
      }
      return;
    }
    // Asked by `start.sh` and by the deployer before either applies anything:
    // exit 10 when a pending migration may only run with the applications
    // stopped, so both refuse instead of breaking the running release.
    if (command === "maintenance-pending") {
      const rows = await status(pool, dir);
      // A database with nothing applied is a fresh install: there is no
      // running release for a destructive migration to break, so the whole
      // chain — marker or not — is an ordinary first migration. Gating it
      // would send a first-time operator to a maintenance command that needs a
      // running instance to drain, on a machine that has never started one.
      const pending = rows.some((row) => row.applied)
        ? rows.filter((row) => !row.applied && row.maintenance)
        : [];
      for (const row of pending) console.log(`${row.version}_${row.name}`);
      process.exitCode = pending.length > 0 ? 10 : 0;
      return;
    }
    if (command === "up") {
      const result = await migrate(pool, dir, { log: (m) => console.log(m) });
      console.log(
        result.applied.length === 0
          ? "schema is up to date (no migrations applied)"
          : `applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`,
      );
      return;
    }
    console.error(`unknown command: ${command} (expected "up", "status" or "maintenance-pending")`);
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
