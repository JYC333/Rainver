import {inOperationWork} from "./operationTransaction.js";
/**
 * Single owner of the `pg` driver for server database access.
 *
 * In bundled compose modes, `SERVER_DATABASE_URL` points at the
 * Postgres owner/app role generated from POSTGRES_* because server is
 * the sole backend.
 */

import { Pool } from "pg";

const pools = new Map<string, Pool>();
const auditPools = new Map<string, Pool>();

export type { Pool, PoolClient } from "pg";

export function getDbPool(databaseUrl: string): Pool {
  if(inOperationWork())throw new Error("Independent pool access refused during core-owned operation work");
  let pool = pools.get(databaseUrl);
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      // A single page load can fan out 15-20 concurrent requests (each
      // making 1-3 queries). Do not cap the pool at 4. Those requests queue
      // for a free connection and the page waits on the queue after each
      // query is already fast. Postgres defaults to max_connections=100 and
      // this process is normally the only client, so there's ample headroom.
      max: 20,
      // Surface connectivity problems as request-time errors, not hangs.
      connectionTimeoutMillis: 5_000,
      // JIT is tuned for large analytical scans; several of our access-control
      // queries build many small correlated subqueries (one per row) whose
      // *estimated* cost crosses jit_above_cost even though actual execution
      // touches almost no rows. Postgres then spends seconds JIT-compiling
      // expression code for a query that runs in milliseconds without it.
      // Do not leave JIT on for these. Passed as a startup
      // parameter so it applies to every physical connection with no extra
      // per-connection round trip.
      options: "-c jit=off",
    });
    // A dropped idle connection must not crash the process.
    // A checked-out Client can emit a second connection error after rejecting
    // its active query. Keep that event from crashing the server. Query promises
    // still reject; pg marks the Client unqueryable and discards it on release.
    pool.on("connect", client => client.on("error", () => {}));
    pool.on("error", () => {});
    pools.set(databaseUrl, pool);
  }
  return pool;
}

/** Host-only audit capacity is independent of held data transactions. Never expose to executors. */
export function getOperationAuditPool(databaseUrl: string): Pool {
  if (inOperationWork()) throw new Error("Independent audit pool access refused during operation work");
  let pool = auditPools.get(databaseUrl);
  if (!pool) {
    pool = new Pool({connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000, options: "-c jit=off"});
    // A checked-out Client can emit a second connection error after rejecting
    // its active query. Keep that event from crashing the server. Query promises
    // still reject; pg marks the Client unqueryable and discards it on release.
    pool.on("connect", client => client.on("error", () => {}));
    pool.on("error", () => {});
    auditPools.set(databaseUrl, pool);
  }
  return pool;
}

/**
 * Ends and forgets the cached pool for `databaseUrl`, if any. Tests drop
 * their per-file database in teardown, and `DROP DATABASE` waits on any
 * connection a service opened through `getDbPool` — forever, when files
 * share a worker.
 */
export async function closeDbPool(databaseUrl: string): Promise<void> {
  const closing = [pools.get(databaseUrl), auditPools.get(databaseUrl)];
  pools.delete(databaseUrl);
  auditPools.delete(databaseUrl);
  await Promise.all(closing.map(pool => pool?.end()));
}
