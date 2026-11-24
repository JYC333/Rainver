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

/** Checks to run at the commit boundary of the transaction open on a client (`withTransaction`, `withQueryableTransaction`). */
const commitGuards = new WeakMap<object, (() => void)[]>();

/**
 * Registers a synchronous check run at this transaction's commit boundary: after its work, immediately before
 * `COMMIT` is issued, with no await between the two, so nothing this process receives in between can be missed.
 * A throw rolls the transaction back and is the caller's error. Only a transaction opened by `withTransaction` or
 * `withQueryableTransaction` has the boundary; registering on any other client throws (never a check silently
 * skipped). Cleared when the transaction ends, so a pooled client carries none into its next one.
 */
export function guardTransactionCommit(client: object, check: () => void): void {
  const guards = commitGuards.get(client);
  if (!guards) throw new Error("A commit guard needs a transaction that runs its commit boundary");
  guards.push(check);
}

/** Opens a client's commit boundary (its BEGIN was sent); returns whether this call owns it (an outer one may). */
export function openCommitBoundary(client: object): boolean {
  if (commitGuards.has(client)) return false;
  commitGuards.set(client, []);
  return true;
}

/** Runs the boundary's checks synchronously; the caller issues `COMMIT` with no await in between. */
export function runCommitBoundary(client: object): void {
  for (const check of commitGuards.get(client) ?? []) check();
}

export function closeCommitBoundary(client: object): void { commitGuards.delete(client); }

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let boundary = false;
  try {
    await client.query("BEGIN");
    boundary = openCommitBoundary(client);
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
      runCommitBoundary(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
    return result;
  } finally {
    if (boundary) closeCommitBoundary(client);
    client.release(unsafeTransactions.has(client));
  }
}

/** Runs one unit of work in a transaction; a caller-owned bounded alternative to `withTransaction(pool, …)`. */
export type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/** `withTransaction` over a pool, or the caller's own runner (e.g. one with a request deadline). */
export function runTransaction<T>(db: Pool | TransactionRunner, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return typeof db === "function" ? db(fn) : withTransaction(db, fn);
}
