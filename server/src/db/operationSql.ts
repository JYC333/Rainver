/** Only SQL code is inspected: punctuation in literals/identifiers/comments is data.
 * This is a transaction-port guard, not a SQL parser or a trusted-code sandbox.
 */
export function operationSqlCode(sql: string, opaqueIdentifiers=false): string {
  let code = '', i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      code += ' ';
    } else if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      code += ' ';
    } else if (/^[uU]&"/.test(sql.slice(i, i + 3))) {
      // This bounded scanner does not decode UESCAPE. Never hide an executable
      // identifier behind the opaque literal placeholder used by port guards.
      throw new Error('Unicode escaped SQL identifiers refused');
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]!, escaped = quote === "'" && /(?:^|[^a-z_0-9$\u0080-\u{10ffff}])[eE]$/iu.test(sql.slice(0, i));
      let closed = false;
      const start = i + 1;
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') i += 2;
        else if (sql[i] === quote && sql[i + 1] === quote) i += 2;
        else if (sql[i++] === quote) { closed = true; break; }
      }
      if (!closed) throw new Error('Unterminated SQL literal');
      // A quoted simple function name still has SQL meaning, e.g. "set_config".
      // Preserve safe identifier spelling for guards; punctuation remains data.
      const identifier = quote === '"' && !opaqueIdentifiers ? sql.slice(start, i - 1).replaceAll('""','"') : '';
      code += /^[a-z_][a-z_0-9]*$/i.test(identifier) ? ` ${identifier} ` : ' ? ';
    } else {
      const tag = sql[i] === '$' && (i === 0 || !/[a-z_0-9$\u0080-\u{10ffff}]/iu.test(sql[i - 1]!))
        ? /^(?:\$[a-z_\u0080-\u{10ffff}][a-z_0-9\u0080-\u{10ffff}]*\$|\$\$)/iu.exec(sql.slice(i))?.[0] : undefined;
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error('Unterminated SQL dollar literal');
        i = end + tag.length;
        code += ' ? ';
      } else code += sql[i++];
    }
  }
  return code.trim().replace(/;\s*$/, '').trim();
}

/** PostgreSQL unquoted identifiers include high-bit characters and internal $.
 * Keep them whole so alias text cannot become control keywords. Literals,
 * comments and quoted identifiers still use the scanner's opaque placeholders.
 */
export function operationSqlTokens(sql: string): string[] {
  return operationSqlCode(sql, true).toLowerCase().match(/[a-z_\u0080-\u{10ffff}][a-z_0-9$\u0080-\u{10ffff}]*|[()?]/gu) ?? [];
}

/** The only lifecycle SQL a domain port may delegate to its owning P1 port. */
export function operationSavepoint(code: string): RegExpExecArray | null {
  return /^(SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK\s+TO(?:\s+SAVEPOINT)?)\s+([a-z_][a-z_0-9]*)$/i.exec(code);
}

/** Session settings are owned by the transaction host, including writable
 * catalog views whose rewrite rules call set_config behind an UPDATE. */
export function assertOperationSessionSql(code: string): void {
  if (/^set\s+(?:(?:local|session)\s+)?(?:session\s+characteristics|default_transaction_)\b/i.test(code) || /^set\s+(?:(?:local|session)\s+)?default_transaction_/i.test(code) || /^reset\s+(?:all\b|default_transaction_)/i.test(code) || /\b(?:set_config|setseed)\s*\(/i.test(code)) {
    throw new Error('Operation session settings refused');
  }
  const names: string[] = code.toLowerCase().match(/[a-z_\u0080-\u{10ffff}][a-z_0-9$\u0080-\u{10ffff}]*/gu) ?? [];
  if (names.includes('pg_settings')) throw new Error('Operation session settings refused');
}
