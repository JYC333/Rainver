import { contentFullOversightSql } from "../access/contentAccessSql.js";

/**
 * SQL counterpart to the `highly_restricted` gate in `memoryReadAuth.ts`.
 * Ordinary read queries must use this alongside `contentReadSql`: only the
 * owner or an active owner/admin in a `full`-oversight Space may read the row.
 * Callers that are creating a write proposal intentionally do not use this
 * helper, because their content predicate opts out of oversight altogether.
 */
export function memorySensitivityReadSql(alias: string, userExpr: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error("Invalid memory sensitivity SQL alias");
  }
  if (!/^\$\d+$/.test(userExpr)) {
    throw new Error("Invalid memory sensitivity SQL user expression");
  }
  return `(
    COALESCE(${alias}.sensitivity_level, 'normal') <> 'highly_restricted'
    OR ${alias}.owner_user_id = ${userExpr}
    OR ${contentFullOversightSql(`${alias}.space_id`, userExpr)}
  )`;
}
