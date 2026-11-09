import {assertSqlIdentifier,contentAccessLevelSql,contentReadSql,roomRunReadAccessSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {attentionSessionReadSql} from '../sessions/attentionRead.js';

const RUN=contentResourceDefinition('run')!;
/** Contract keys whose Runs carry an extra domain read gate in `getVisibleRun`. */
const DOMAIN_GATED_KEYS=`array['reading_method','reading_method_trial','reading_method_generation','project_reading_theme']`;

/**
 * A conservative SQL gate for read models that must filter before they
 * aggregate, count or page: never wider than `getVisibleRun(...)` with an
 * unwithheld (`full`) body, and narrower in two places. It shares the content
 * read, Room membership and access-level (including oversight) layers. It
 * additionally requires the Run's conversation to be readable, as for every
 * session aggregate, and it excludes Runs behind a domain read gate (Reading
 * method, Reading theme) fail-closed, because that gate is not expressible
 * here; workspace progress never needs them.
 */
export function runBodyReadableSql(alias:string,userExpr:string):string{
 assertSqlIdentifier(alias,'alias');
 const active=RUN.activePredicate?.(alias)??'true';
 return `(${active} AND ${contentReadSql('run',alias,userExpr)}
  AND ${roomRunReadAccessSql(`${alias}.id`,`${alias}.space_id`,userExpr)}
  AND ${contentAccessLevelSql({definition:RUN,alias,userExpr})}='full'
  AND NOT (CASE WHEN jsonb_typeof(${alias}.contract_snapshot_json->'workflow_input_json')='object'
   THEN (${alias}.contract_snapshot_json->'workflow_input_json') ?| ${DOMAIN_GATED_KEYS} ELSE false END)
  AND (${alias}.session_id IS NULL OR EXISTS(SELECT 1 FROM sessions ${alias}_session WHERE ${alias}_session.id=${alias}.session_id
   AND ${alias}_session.space_id=${alias}.space_id AND ${attentionSessionReadSql(`${alias}_session`,userExpr)})))`;
}
