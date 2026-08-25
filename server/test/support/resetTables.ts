import type { Pool } from "pg";

/**
 * Empties the listed tables between tests — the job `TRUNCATE ... CASCADE`
 * used to do in `beforeEach`.
 *
 * TRUNCATE is the wrong tool for that job on this schema. `TRUNCATE spaces,
 * users CASCADE` reaches 281 of the ~300 tables through foreign keys, and for
 * every one of them (plus its ~1000 indexes) Postgres allocates a fresh
 * relfilenode and takes an AccessExclusiveLock, whether or not the table holds
 * a row. Measured on the shared test container that was 1–15 seconds per
 * call; with a dozen workers hammering one instance it was most of the wall
 * clock of the whole suite. DELETE on an empty table is microseconds.
 *
 * This keeps TRUNCATE's semantics — `cascade` follows foreign keys to every
 * referencing table, transitively, exactly as `TRUNCATE ... CASCADE` does —
 * but does it in one round trip once the closure is known: a `DO` block that
 * disables FK triggers for the transaction (`session_replication_role =
 * replica`, hence the test user's superuser role) and deletes from each reached table that has ever
 * held a row. A freshly created table has no pages until something is inserted
 * (`pg_relation_size` = 0), and most tables in most files never are, so the
 * sweep touches a few dozen tables rather than a few hundred; a table that was
 * used keeps its pages after DELETE and stays in the sweep, which is cheap.
 * Sequences are not reset; tests here key on UUIDs.
 */
export async function resetTables(
  pool: Pool,
  tables: readonly string[],
  options: { cascade?: boolean } = {},
): Promise<void> {
  if (tables.length === 0) return;
  const relations = await reachedRelations(pool, tables, options.cascade === true);
  await pool.query(`
    DO $reset$
    DECLARE
      rel regclass;
    BEGIN
      PERFORM set_config('session_replication_role', 'replica', true);
      FOR rel IN
        SELECT oid::regclass FROM unnest(ARRAY[${relations.join(", ")}]::oid[]) AS t(oid)
         WHERE pg_relation_size(oid) > 0
      LOOP
        EXECUTE format('DELETE FROM %s', rel);
      END LOOP;
    END
    $reset$;
  `);
}

/**
 * The set of relations a reset touches, as oids. Walking pg_constraint for the
 * cascade closure costs more than the reset itself, and neither the schema
 * nor a pool's database changes between calls, so it is computed once per
 * pool and table list.
 */
const closureCache = new WeakMap<Pool, Map<string, number[]>>();

async function reachedRelations(pool: Pool, tables: readonly string[], cascade: boolean): Promise<number[]> {
  const key = `${cascade ? "cascade:" : "exact:"}${[...tables].sort().join(",")}`;
  let perPool = closureCache.get(pool);
  if (!perPool) {
    perPool = new Map();
    closureCache.set(pool, perPool);
  }
  const cached = perPool.get(key);
  if (cached) return cached;

  const roots = tables.map((name) => `'${quoteLiteral(name)}'::regclass`).join(", ");
  const { rows } = await pool.query<{ oid: number }>(
    cascade
      ? `WITH RECURSIVE reached(oid) AS (
           SELECT oid FROM unnest(ARRAY[${roots}]) AS t(oid)
           UNION
           SELECT c.conrelid FROM pg_constraint c JOIN reached r ON c.confrelid = r.oid
            WHERE c.contype = 'f'
         ) SELECT DISTINCT oid::int AS oid FROM reached`
      : `SELECT oid::int AS oid FROM unnest(ARRAY[${roots}]) AS t(oid)`,
  );
  const oids = rows.map((row) => row.oid);
  perPool.set(key, oids);
  return oids;
}

function quoteLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
