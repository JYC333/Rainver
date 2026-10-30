import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { sourceItemReadableClause } from "./sourceItemAccess.js";

const ITEM_ACCESS = contentResourceDefinition("source_item")!;
const CONNECTION_ACCESS = contentResourceDefinition("source_connection")!;

/** Jobs expose content-bearing metadata, so every named parent must still grant full access. */
export function sourceJobReadableClause(alias: string, userParam: string, includeOversight = true): string {
  return `(
    (${alias}.source_item_id IS NOT NULL OR ${alias}.connection_id IS NOT NULL)
    AND (${alias}.source_item_id IS NULL OR EXISTS (
      SELECT 1 FROM source_items job_item
       WHERE job_item.space_id = ${alias}.space_id AND job_item.id = ${alias}.source_item_id
         AND job_item.deleted_at IS NULL
         AND ${sourceItemReadableClause("job_item", userParam, false, { includeOversight })}
         AND ${contentAccessLevelSql({ definition: ITEM_ACCESS, alias: "job_item", userExpr: userParam, includeOversight })} = 'full'
    ))
    AND (${alias}.connection_id IS NULL OR EXISTS (
      SELECT 1 FROM source_connections job_connection
       WHERE job_connection.space_id = ${alias}.space_id AND job_connection.id = ${alias}.connection_id
         AND job_connection.deleted_at IS NULL AND job_connection.status <> 'archived'
         AND ${contentReadSql("source_connection", "job_connection", userParam, { includeOversight })}
         AND ${contentAccessLevelSql({ definition: CONNECTION_ACCESS, alias: "job_connection", userExpr: userParam, includeOversight })} = 'full'
    ))
  )`;
}
