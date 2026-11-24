/**
 * CLI entry for the server migration runner: `node dist/db/migrateCli.js [up|status|pending|maintenance-pending]`.
 *
 * Schema migrations are explicit ops commands, not server-startup side effects.
 * Run from `server/` so the default migrations directory resolves, or set
 * `SERVER_MIGRATIONS_DIR`.
 */

import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { getDbPool } from "./pool.js";
import { status } from "./migrator.js";
import { migrateUp } from "./migrateUp.js";
import { DEFAULT_APP_ROLE, DEFAULT_BACKUP_ROLE, grantPluginRuntimeMemberships, inspectRuntimeRoles, reconcileRuntimeRoles } from "./runtimeRoles.js";

const appRole = () => process.env.RAINVER_DB_APP_ROLE?.trim() || DEFAULT_APP_ROLE;
const backupRole = () => process.env.RAINVER_DB_BACKUP_ROLE?.trim() || DEFAULT_BACKUP_ROLE;
const COMMANDS = "up, status, pending, maintenance-pending, plugin-install, plugin-reconcile, runtime-roles-plan, runtime-roles-reconcile";

function migrationsDir(): string {
  const override = process.env.SERVER_MIGRATIONS_DIR?.trim();
  if (override) return resolve(override);
  // dist/db/migrateCli.js -> server/migrations
  return resolve(import.meta.dirname, "..", "..", "migrations");
}

async function main(): Promise<void> {
  const command = (process.argv[2] ?? "up").toLowerCase();
  if (command === "--help" || command === "-h") {
    console.log(`Commands: ${COMMANDS}`);
    return;
  }
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
      const existing = rows.some((row) => row.applied);
      const {operationPluginsPending}=await import("../modules/plugins/offline.js");
      const pluginPending=existing?await operationPluginsPending(pool):[];
      const pending = existing
        ? rows.filter((row) => !row.applied && row.maintenance)
        : [];
      for (const row of pending) console.log(`${row.version}_${row.name}`);
      for(const id of pluginPending)console.log(id);
      process.exitCode = pending.length+pluginPending.length > 0 ? 10 : 0;
      return;
    }
    // Asked by `migrate.sh` before its pre-migration dump: the first line is
    // the latest applied version (`none` on an empty database), followed by
    // pending files; exit 10 when anything is pending, 0 when nothing is.
    if (command === "pending") {
      const rows = await status(pool, dir);
      const {operationPluginsPending}=await import("../modules/plugins/offline.js");
      const pluginPending=await operationPluginsPending(pool);
      const pending = rows.filter((row) => !row.applied);
      console.log(rows.filter((row) => row.applied).at(-1)?.version ?? "none");
      for (const row of pending) console.log(`${row.version}_${row.name}`);
      for(const id of pluginPending)console.log(id);
      process.exitCode = pending.length+pluginPending.length > 0 ? 10 : 0;
      return;
    }
    if(command === "plugin-reconcile"||command === "plugin-install"){
      const {offlineOperationPlugins}=await import("../modules/plugins/offline.js");
      await offlineOperationPlugins(pool,command==="plugin-install"?"migrate":"reconcile",process.argv.includes("--repair-failed"));
      await grantPluginRuntimeMemberships(pool, appRole());
      return;
    }
    // ADR 0031 owner-channel role commands; never run by server start.
    if (command === "runtime-roles-plan") {
      console.log(JSON.stringify(await inspectRuntimeRoles(pool, { appRole: appRole(), backupRole: backupRole() }), null, 2));
      return;
    }
    if (command === "runtime-roles-reconcile") {
      if (process.argv.includes("--if-present") && !(await inspectRuntimeRoles(pool, { appRole: appRole(), backupRole: backupRole() })).app.exists) {
        console.log("runtime roles not provisioned; nothing to reconcile");
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await reconcileRuntimeRoles(client, {
          appRole: appRole(), backupRole: backupRole(),
          appPassword: process.env.RAINVER_DB_APP_PASSWORD || undefined,
          backupPassword: process.env.RAINVER_DB_BACKUP_PASSWORD || undefined,
        });
        await client.query("COMMIT");
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return;
    }
    if (command === "up") {
      const result = await migrateUp(pool, dir, appRole(), (m) => console.log(m));
      console.log(
        result.applied.length === 0
          ? "schema is up to date (no migrations applied)"
          : `applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`,
      );
      return;
    }
    console.error(`unknown command: ${command} (expected one of: ${COMMANDS})`);
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
