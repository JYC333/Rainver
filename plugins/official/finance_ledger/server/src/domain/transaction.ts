import type { Queryable } from "@rainver/protocol";

/** `PluginHostContext.db` satisfies pg.Pool; a pooled client also has `release`. */
interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

const IN_TRANSACTION = Symbol("financeLedgerTransaction");

type TransactionQueryable = Queryable & { readonly [IN_TRANSACTION]: true };

function isPool(db: Queryable): db is PoolLike {
  const candidate = db as Partial<PoolLike> & { release?: unknown };
  return typeof candidate.connect === "function" && typeof candidate.release !== "function";
}

export function inTransaction(db: Queryable): boolean {
  return (db as Partial<TransactionQueryable>)[IN_TRANSACTION] === true;
}

/**
 * Runs `work` as one database transaction, so a write that fails part way
 * leaves nothing behind. Given anything other than the host pool — a client
 * the caller already holds, inside its own transaction — `work` runs on it
 * as it is.
 */
export async function withTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  if (inTransaction(db) || !isPool(db)) return work(db);
  const client = await db.connect();
  const tx: TransactionQueryable = {
    query: (sql, params) => client.query(sql, params),
    [IN_TRANSACTION]: true,
  };
  try {
    await client.query("BEGIN");
    const result = await work(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs a step that may fail without failing the transaction around it: a
 * failed statement aborts a PostgreSQL transaction, so inside one the step
 * runs under a savepoint and is undone alone.
 */
export async function attempt<T>(db: Queryable, work: () => Promise<T>): Promise<T> {
  if (!inTransaction(db)) return work();
  await db.query("SAVEPOINT finance_attempt");
  try {
    const result = await work();
    await db.query("RELEASE SAVEPOINT finance_attempt");
    return result;
  } catch (err) {
    await db.query("ROLLBACK TO SAVEPOINT finance_attempt");
    throw err;
  }
}
