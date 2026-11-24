import { Client, type Pool, type PoolClient } from "pg";
import type { Queryable } from "../modules/routeUtils/common.js";

/**
 * Run `fn` holding a session advisory lock on `lockKey`, on a connection of
 * its own so the lock lasts across `fn`'s transactions and is released by
 * PostgreSQL if this process dies. Waits until the lock is free.
 */
export async function withDedicatedSessionAdvisoryLock<T>(
  db: Queryable,
  lockKey: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const result = await sessionAdvisoryLock(db, lockKey, fn, true);
  return (result as { value: T }).value;
}

/**
 * The same lock without waiting: `{ acquired: false }` when another session
 * holds it, so a caller can skip or refuse work that is already in hand.
 */
export async function tryWithDedicatedSessionAdvisoryLock<T>(
  db: Queryable,
  lockKey: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return sessionAdvisoryLock(db, lockKey, fn, false);
}

/** Execute database work on the locking session itself. If that connection
 * disappears, PostgreSQL releases the lock and every later write by this
 * callback fails on the same connection. The callback can open short
 * transactions on the session while the lock spans the whole operation. */
export async function tryWithSessionBoundAdvisoryLock<T>(
  db: Queryable,
  lockKey: string,
  fn: (db: Queryable, signal: AbortSignal) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return sessionAdvisoryLock(db, lockKey, fn, false, true);
}

async function sessionAdvisoryLock<T>(
  db: Queryable,
  lockKey: string,
  fn: (db: Queryable, signal: AbortSignal) => Promise<T>,
  wait: boolean,
  bindWork = false,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const connectable = db as Queryable & {
    connect?: () => Promise<PoolClient>;
    release?: () => void;
    options?: Pool["options"];
  };
  const alreadyClient = typeof connectable.release === "function";
  const isPool = !alreadyClient
    && typeof connectable.connect === "function"
    && connectable.options !== undefined;
  const lifetime = new AbortController();
  if (!alreadyClient && !isPool) return { acquired: true, value: await fn(db, lifetime.signal) };

  let client: PoolClient | Client;
  // The dedicated connection can be idle while the callback performs external
  // work. A dropped connection emits an error even when no query is awaiting
  // a result. Notify session-bound work and skip the now-unnecessary unlock.
  for (;;) {
    client = alreadyClient
      ? connectable as unknown as PoolClient
      : new Client(connectable.options);
    if (!alreadyClient) {
      (client as Client).on("error", (error) => { lifetime.abort(error); });
      await (client as Client).connect();
    }
    let acquired;
    try {
      acquired = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired",
        [lockKey],
      );
    } catch (error) {
      if (!alreadyClient) await (client as Client).end().catch(() => {});
      throw error;
    }
    if (acquired.rows[0]?.acquired) break;
    if (!alreadyClient) await (client as Client).end();
    if (!wait) return { acquired: false };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  try {
    const workDb = alreadyClient ? client : bindWork ? sessionQueryable(client, lifetime.signal) : db;
    return { acquired: true, value: await fn(workDb, lifetime.signal) };
  } finally {
    if (lifetime.signal.aborted) {
      await (client as Client).end().catch(() => {});
    } else {
      await unlock(client, alreadyClient, lockKey);
    }
  }
}

/** Adapt a dedicated pg Client to the shared transaction helper's borrowing
 * contract. The borrowed Queryable joins nested transactions, and releasing
 * it leaves ownership of the connection with the advisory-lock scope. */
function sessionQueryable(client: Queryable, signal: AbortSignal): Queryable {
  const query: Queryable["query"] = async (sql, params) => {
    signal.throwIfAborted();
    return client.query(sql, params);
  };
  const session = {
    query,
    async connect() {
      signal.throwIfAborted();
      return { query, release() {} };
    },
  };
  return session;
}

async function unlock(client: PoolClient | Client, alreadyClient: boolean, lockKey: string): Promise<void> {
  let unlocked = false;
  try {
    const result = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock(hashtextextended($1::text, 0)) AS unlocked",
      [lockKey],
    );
    unlocked = result.rows[0]?.unlocked === true;
  } finally {
    if (!alreadyClient) await (client as Client).end().catch(() => {});
    else if (!unlocked) {
      (client as PoolClient).release(
        new Error(`Session advisory unlock failed for ${lockKey}`),
      );
    }
  }
}
