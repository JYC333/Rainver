/**
 * Single owner of the `pg` driver for server database access.
 *
 * In bundled compose modes, `SERVER_DATABASE_URL` points at the
 * Postgres owner/app role generated from POSTGRES_* because server is
 * the sole backend.
 */

import { Pool } from "pg";

const pools = new Map<string, Pool>();

export type { Pool, PoolClient } from "pg";

export function getDbPool(databaseUrl: string): Pool {
  let pool = pools.get(databaseUrl);
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      // A single page load can fan out 15-20 concurrent requests (each
      // making 1-3 queries); at max=4 those queued for a free connection in
      // batches, adding real wall-clock latency even after each individual
      // query got fast (observed: 16 concurrent 50ms queries took ~270ms
      // instead of ~50ms). Postgres defaults to max_connections=100 and this
      // process is normally the only client, so there's ample headroom.
      max: 20,
      // Surface connectivity problems as request-time errors, not hangs.
      connectionTimeoutMillis: 5_000,
      // JIT is tuned for large analytical scans; several of our access-control
      // queries build many small correlated subqueries (one per row) whose
      // *estimated* cost crosses jit_above_cost even though actual execution
      // touches almost no rows. Postgres then spends seconds JIT-compiling
      // expression code for a query that runs in milliseconds without it
      // (observed: a 63-row evidence-matrix query went from ~2.8s to
      // ~150ms with JIT off, no query change). Passed as a startup
      // parameter so it applies to every physical connection with no extra
      // per-connection round trip.
      options: "-c jit=off",
    });
    // A dropped idle connection must not crash the process.
    pool.on("error", () => {});
    pools.set(databaseUrl, pool);
  }
  return pool;
}
