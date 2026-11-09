import { operationSqlCode, operationSqlTokens, operationSavepoint, assertOperationSessionSql } from '../../db/operationSql.js';

// PluginDb is a data port. Utility commands (including wrappers such as
// EXPLAIN ANALYZE) belong to the offline host, not this invocation capability.
const dataStatements = new Set(['select', 'insert', 'update', 'delete', 'merge', 'with', 'values', 'table']);
const sqlEvaluators = new Set(['query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema', 'ts_stat', 'ts_rewrite']);

// PostgreSQL's SQL-visible large-object API, not a prefix reservation for
// plugin columns/aliases. See PostgreSQL 18, Large Objects / Server-Side Functions.
const largeObjectFunctions = new Set([
  'lo_from_bytea', 'lo_put', 'lo_get', 'lo_creat', 'lo_create', 'lo_unlink',
  'lo_import', 'lo_export', 'lo_open', 'lo_close', 'lo_lseek', 'lo_lseek64',
  'lo_tell', 'lo_tell64', 'lo_truncate', 'lo_truncate64', 'lowrite', 'loread',
]);

/** Trusted-code safeguards, not a general PostgreSQL parser or hostile sandbox.
 * Keep statement admission and forbidden side-effect functions together; SQL
 * strings remain opaque, so server-side SQL evaluators cannot enter this port.
 */
export function assertPluginSql(sql: string): void {
  const code = operationSqlCode(sql);
  assertOperationSessionSql(code);
  // P1 translates these labels to private savepoints and checks ownership.
  if (operationSavepoint(code)) return;
  const first = /^[a-z]+\b/i.exec(code)?.[0]?.toLowerCase();
  if (!first || !dataStatements.has(first) || code.includes(';')) throw new Error('Plugin SQL control refused');
  if (hasSelectInto(sql)) throw new Error('Plugin SELECT INTO refused');
  const identifiers = code.toLowerCase().match(/[a-z_\u0080-\u{10ffff}][a-z_0-9$\u0080-\u{10ffff}]*/gu) ?? [];
  for (const name of identifiers) {
    if (name === 'set_config' || name === 'pg_notify' || /^pg_(?:try_)?advisory_/.test(name) || name.startsWith('dblink') || sqlEvaluators.has(name)) {
      throw new Error('Plugin SQL control refused');
    }
  }
  const calls = code.toLowerCase().match(/[a-z_\u0080-\u{10ffff}][a-z_0-9$\u0080-\u{10ffff}]*\s*(?=\()/gu) ?? [];
  if (calls.some(name => largeObjectFunctions.has(name.trim()))) throw new Error('Plugin large-object function refused');
}

/** AS can introduce an alias or a CTE body; DML-looking aliases never reset a
 * SELECT scope. Quoted identifiers are opaque to this keyword-only check. */
function hasSelectInto(sql: string): boolean {
  const stack: boolean[] = [false];
  let alias = false;
  for (const token of operationSqlTokens(sql)) {
    if (alias) {
      alias = false;
      if (token !== '(') continue;
    }
    if (token === 'as') { alias = true; continue; }
    if (token === '(') stack.push(false);
    else if (token === ')') { if (stack.length > 1) stack.pop(); }
    else if (token === 'select') stack[stack.length - 1] = true;
    else if (token === 'into' && stack[stack.length - 1]) return true;
  }
  return false;
}
