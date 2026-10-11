import { domainStatusSources } from "../modules/ontology/entities.js";
/**
 * Domain status for a `space_objects` row.
 *
 * Status lives on the extension table (ADR 0012 decision 1 / B12D). Do not
 * put a status constraint on the root that branches on `object_type`. A new
 * domain must not have to edit a root-table constraint to add a status.
 *
 * A reader that already knows the object type should simply read the
 * extension table's own `status` column. These helpers exist only for
 * **polymorphic** readers — ones that select or filter status across several
 * object types at once — which would otherwise have to repeat six LEFT JOINs.
 *
 * Do not substitute `archived_at` / `deleted_at` for a status filter. The two
 * are not equivalent: `knowledge/repository.ts` archives a Source without
 * writing `archived_at`, and `superseded` deliberately writes no timestamp at
 * all. The one sanctioned substitution is
 * `CONTENT_RESOURCE_DEFINITIONS.activePredicate` for `space_object`, valid only
 * because `deleted` is reachable for Notes and Knowledge items alone and both
 * write the timestamp. See `.agent/architecture/CLAIM_FACT_ATOM_MODEL.md`.
 */

/**
 * Derived from the entity registry rather than listed here. Do not hardcode
 * the list. A domain left off it resolves to NULL, and `NULL NOT IN (...)`
 * filters every row of that domain out. That is how an Inquiry Thread
 * disappears from the generic graph projection.
 */
function statusSources(): readonly { table: string; alias: string; column: string }[] {
  return domainStatusSources().map((source, index) => ({
    ...source,
    alias: `st${index}`,
  }));
}

function assertSqlIdentifier(value: string, label: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Invalid object status SQL ${label}`);
  }
}

/**
 * `LEFT JOIN`s every extension table onto a `space_objects` alias. The join
 * aliases are namespaced by `suffix` so a query can use this more than once.
 */
export function objectStatusJoinSql(objectAlias: string, suffix = "st"): string {
  assertSqlIdentifier(objectAlias, "alias");
  assertSqlIdentifier(suffix, "suffix");
  return statusSources().map(({ table, alias }) => {
    const joinAlias = `${alias}_${suffix}`;
    return `LEFT JOIN ${table} ${joinAlias}
             ON ${joinAlias}.object_id = ${objectAlias}.id
            AND ${joinAlias}.space_id = ${objectAlias}.space_id`;
  }).join("\n           ");
}

/**
 * The object's domain status, resolved across the joined extension tables.
 * Exactly one of them matches, because an object row has exactly one
 * extension. Pair with {@link objectStatusJoinSql} using the same `suffix`.
 */
export function objectStatusSql(suffix = "st"): string {
  assertSqlIdentifier(suffix, "suffix");
  const columns = statusSources().map(({ alias, column }) => `${alias}_${suffix}.${column}`);
  return `COALESCE(${columns.join(", ")})`;
}

/**
 * The same value as {@link objectStatusSql}, expressed as correlated scalar
 * subqueries so it can be dropped into an existing query without touching its
 * `FROM` clause. Prefer this when a predicate needs the status but the query
 * shape is not yours to change — for example a shared clause helper applied to
 * several different aliases in one statement. Each subquery is a primary-key
 * lookup on the extension table.
 */
export function objectStatusScalarSql(objectAlias: string): string {
  assertSqlIdentifier(objectAlias, "alias");
  const lookups = statusSources().map(
    ({ table, alias, column }) =>
      `(SELECT ${alias}.${column} FROM ${table} ${alias}`
      + ` WHERE ${alias}.object_id = ${objectAlias}.id`
      + ` AND ${alias}.space_id = ${objectAlias}.space_id)`,
  );
  return `COALESCE(${lookups.join(", ")})`;
}
