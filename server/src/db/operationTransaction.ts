import { randomUUID } from "node:crypto";
import { operationSqlCode } from "./operationSql.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Queryable, QueryResult } from '../modules/routeUtils/common.js';
const operationWork = new AsyncLocalStorage<boolean>();
export function inOperationWork(): boolean {
  return operationWork.getStore() === true;
}
export function runOperationWork<T>(work: () => Promise<T>): Promise<T> {
  return operationWork.run(true, work);
}
const ports = new WeakMap<object, {
  active: boolean;
}>();
export function isOperationTransaction(db: Queryable): boolean {
  const state = ports.get(db);
  if (!state) return false;
  if (!state.active) throw new Error('Operation transaction expired');
  return true;
}
/** Host owns lifecycle. No pool, release, connect or transaction control escapes. Not a code sandbox. */
export function operationTransaction(db: Queryable): {
  db: Queryable;
  close(): void;
} {
  const state = {
    active: true
  };
  // Domain labels are translated into private host-owned savepoints. They cannot
  // target operation_work / approval savepoints or release the outer transaction.
  const savepoints: {label: string; name: string}[] = [];
  const prefix = `domain_${randomUUID().replaceAll('-', '')}_`;
  let nextSavepoint = 0;
  const port: Queryable = {
    async query<Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>> {
      if (!state.active) throw new Error('Operation transaction expired');
      const code = operationSqlCode(sql);
      if (code.includes(';')) throw new Error('Operation transaction control refused');
      if (/^set\s+(?:(?:local|session)\s+)?(?:session\s+characteristics|default_transaction_)\b/i.test(code) || /^set\s+(?:(?:local|session)\s+)?default_transaction_/i.test(code)) throw new Error('Operation session settings refused');
      if (/^reset\s+(?:all\b|default_transaction_)/i.test(code) || /\bset_config\s*\(/i.test(code)) throw new Error('Operation session settings refused');
      const savepoint = /^(SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK\s+TO(?:\s+SAVEPOINT)?)\s+([a-z_][a-z_0-9]*)$/i.exec(code);
      if (savepoint) {
        if (params?.length) throw new Error('Savepoint parameters refused');
        const label = savepoint[2]!.toLowerCase();
        const action = savepoint[1]!.toUpperCase();
        if (action === 'SAVEPOINT') {
          const name = `${prefix}${nextSavepoint++}`;
          const result = await db.query<Row>(`SAVEPOINT ${name}`);
          savepoints.push({label, name});
          return result;
        }
        let index = savepoints.length - 1;
        while (index >= 0 && savepoints[index]!.label !== label) index--;
        if (index < 0) throw new Error('Operation savepoint is not owned by this port');
        const point = savepoints[index]!;
        const release = action.startsWith('RELEASE');
        const result = await db.query<Row>(`${release ? 'RELEASE' : 'ROLLBACK TO'} SAVEPOINT ${point.name}`);
        savepoints.splice(release ? index : index + 1);
        return result;
      }
      if (/^(begin|commit|rollback|abort|savepoint|release|start\s+transaction|set\s+(?:local\s+|session\s+)?transaction|prepare\s+transaction|end)\b/i.test(code)) throw new Error('Operation transaction control refused');
      return db.query<Row>(sql, params);
    }
  };
  ports.set(port, state);
  return {
    db: port,
    close() {
      state.active = false;
    }
  };
}
