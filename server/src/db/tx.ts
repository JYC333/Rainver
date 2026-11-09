/**
 * Transaction helper over the shared `pg` pool.
 *
 * `withTransaction` runs `fn` inside a single `BEGIN`/`COMMIT`, rolling back on
 * any thrown error and always releasing the client back to the pool. This is the
 * substrate domain repositories use for multi-statement writes that must be
 * atomic (e.g. proposal apply: active-state write + provenance + accept state).
 *
 * Schema migration is explicit and separate; this only governs how the control
 * plane groups its own statements.
 */

import type { Pool, PoolClient } from "pg";

const unsafeTransactions = new WeakSet<object>();
/** Host tripwires poison a connection; caught plugin errors cannot make it reusable. */
export function poisonTransaction(client: object): void { unsafeTransactions.add(client); }

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let result: T;
    try {
      result = await fn(client);
    } catch (err) {
      // Roll back the failed unit of work; never let a half-applied transaction
      // leak back into the pool.
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
    try {
      if (unsafeTransactions.has(client)) throw new Error("Unsafe transaction refused");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
    return result;
  } finally {
    client.release(unsafeTransactions.has(client));
  }
}
