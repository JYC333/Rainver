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

/**
 * SQL counterpart to the agent-scope rule in `memoryReadAuth.ts`.
 *
 * An `agent`-scope row is the Agent's owner's alone. A note carries the Room
 * it was learned in and is delivered only where that Room's audience already
 * reached ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md)
 * §4, ADR 0018); Space oversight is not that audience, and reading the note on
 * the Memory page would cross the Room the delivery path refuses to cross.
 * Oversight keeps `user` and `project` scope, where the accountability it
 * exists for actually lives.
 *
 * Must accompany `contentReadSql` on every query that can return an
 * agent-scope row. Queries that exclude the scope outright (the retrieval
 * index, consolidation) do not need it.
 */
export function memoryAgentScopeReadSql(alias: string, userExpr: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error("Invalid memory agent-scope SQL alias");
  }
  if (!/^\$\d+$/.test(userExpr)) {
    throw new Error("Invalid memory agent-scope SQL user expression");
  }
  return `(${alias}.scope_type <> 'agent' OR ${alias}.owner_user_id = ${userExpr})`;
}
