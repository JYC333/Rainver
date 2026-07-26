import { Client, type Pool, type PoolClient } from "pg";
import type { Queryable } from "../modules/routeUtils/common";

export async function withDedicatedSessionAdvisoryLock<T>(
  db: Queryable,
  lockKey: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const connectable = db as Queryable & {
    connect?: () => Promise<PoolClient>;
    release?: () => void;
    options?: Pool["options"];
  };
  const alreadyClient = typeof connectable.release === "function";
  const isPool = !alreadyClient
    && typeof connectable.connect === "function"
    && connectable.options !== undefined;
  if (!alreadyClient && !isPool) return fn(db);

  let client: PoolClient | Client;
  for (;;) {
    client = alreadyClient
      ? connectable as unknown as PoolClient
      : new Client(connectable.options);
    if (!alreadyClient) await (client as Client).connect();
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  try {
    return await fn(alreadyClient ? client : db);
  } finally {
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
          new Error("Run finalization advisory unlock failed"),
        );
      }
    }
  }
}
