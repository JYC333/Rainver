import type { Pool } from "pg";
import { migrate } from "./migrator.js";
import { grantPluginRuntimeMemberships, protectMigrationJournal } from "./runtimeRoles.js";

/**
 * The owner-channel `migrate up` sequence (migrateCli `up`): core migrations,
 * then the journal protection an already provisioned app role needs (roles
 * reconciled on an empty database give it default DML on the journal the first
 * migration creates — ADR 0031), then pending operation-plugin installs and the
 * new runtime roles' SET memberships. No role/owner DDL runs when nothing is
 * pending beyond that declared journal revoke.
 */
export async function migrateUp(pool: Pool, dir: string, appRole: string, log: (message: string) => void = () => {}): Promise<{ applied: string[] }> {
  const result = await migrate(pool, dir, { log });
  await protectMigrationJournal(pool, appRole);
  const { offlineOperationPlugins, operationPluginsPending } = await import("../modules/plugins/offline.js");
  if ((await operationPluginsPending(pool)).length) {
    await offlineOperationPlugins(pool, "migrate");
    await grantPluginRuntimeMemberships(pool, appRole);
  }
  return result;
}
