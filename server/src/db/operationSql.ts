/** Only SQL code is inspected: punctuation in literals/identifiers/comments is data.
 * This is a transaction-port guard, not a SQL parser or a trusted-code sandbox.
 */
export function operationSqlCode(sql: string): string {
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
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]!, escaped = quote === "'" && /(?:^|[^\w$])[eE]$/.test(sql.slice(0, i));
      let closed = false;
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') i += 2;
        else if (sql[i] === quote && sql[i + 1] === quote) i += 2;
        else if (sql[i++] === quote) { closed = true; break; }
      }
      if (!closed) throw new Error('Unterminated SQL literal');
      code += ' ? ';
    } else {
      const tag = sql[i] === '$' && (i === 0 || !/[\w$]/.test(sql[i - 1]!))
        ? /^(?:\$[a-zA-Z_][a-zA-Z_0-9]*\$|\$\$)/.exec(sql.slice(i))?.[0] : undefined;
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
