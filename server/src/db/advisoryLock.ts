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

async function sessionAdvisoryLock<T>(
  db: Queryable,
  lockKey: string,
  fn: (db: Queryable) => Promise<T>,
  wait: boolean,
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
  if (!alreadyClient && !isPool) return { acquired: true, value: await fn(db) };

  let client: PoolClient | Client;
  // The dedicated connection sits idle while `fn` runs on the pool. If the
  // server drops it (restart, failover, terminated backend), pg emits 'error'
  // on the client; unheard, that is an uncaught exception that takes the whole
  // process down. The session lock is gone with the session, so the only thing
  // left to do is skip the unlock.
  let lockConnectionLost = false;
  for (;;) {
    client = alreadyClient
      ? connectable as unknown as PoolClient
      : new Client(connectable.options);
    if (!alreadyClient) {
      (client as Client).on("error", () => { lockConnectionLost = true; });
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
    return { acquired: true, value: await fn(alreadyClient ? client : db) };
  } finally {
    if (lockConnectionLost) {
      await (client as Client).end().catch(() => {});
    } else {
      await unlock(client, alreadyClient, lockKey);
    }
  }
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
